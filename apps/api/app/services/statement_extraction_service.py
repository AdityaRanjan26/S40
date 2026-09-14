"""
Bank statement text extraction and OCR service.
Extracts raw text, preserves page boundaries, updates statement processing lifecycle,
and stores extraction artifacts for downstream parsing.

Supports:
1. Native digital PDFs (direct stream text extraction via pypdf)
2. Scanned / raster-only PDFs (page image extraction + OCR via Tesseract/Pillow)
3. Image statements (PNG, JPEG, WebP, etc. via OCR)
"""

from datetime import datetime, timezone
import io
import logging
import os
import shutil
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException, status
from PIL import Image
import pypdf

from app.schemas.statement import (
    StatementDocumentMetadata,
    StatementExtractionResponse,
    StatementOCRStatusResponse,
    StatementPageText,
    StatementProcessingStatus,
)

logger = logging.getLogger(__name__)

# Type alias for OCR engine hook
OCREngineCallable = Callable[[bytes, str], Optional[str]]


class PdfMalformedError(Exception):
    """PDF couldn't be parsed at all, or has zero pages."""


class PdfPasswordProtectedError(Exception):
    """PDF is encrypted and the empty-password decrypt attempt failed."""


class PdfUnreadableError(Exception):
    """No text found — neither a digital text layer nor OCR on embedded
    page images recovered anything."""


def extract_pdf_page_texts(
    raw_bytes: bytes, ocr_fn: OCREngineCallable, password: Optional[str] = None
) -> tuple[List[str], bool]:
    """The actual "get text out of a PDF" algorithm, standalone: digital
    text-stream extraction first, OCR on embedded page images as a
    fallback if that recovers zero characters. Returns
    (page_texts, is_scanned).

    Pulled out of StatementExtractionService._extract_pdf so the same
    algorithm backs both that class's upload_id/record-dict workflow
    (unchanged behavior — it now just delegates here, with password=None,
    same as before this parameter existed) and
    app/services/statement_parser_service.py's OCR-fallback path for
    statements pdfplumber couldn't find a table in, which does pass a
    caller-supplied password through here. One implementation of "how do
    we get text out of a PDF or image," not two.
    """
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
    except pypdf.errors.PdfReadError as exc:
        raise PdfMalformedError(f"Unable to parse PDF document or file is corrupted: {exc}") from exc
    except Exception as exc:
        raise PdfMalformedError(f"Invalid PDF structure: {exc}") from exc

    if reader.is_encrypted:
        try:
            decrypted = reader.decrypt(password or "")
        except Exception as exc:
            raise PdfPasswordProtectedError(
                "PDF statement is encrypted and password-protected."
            ) from exc
        if decrypted == 0:
            raise PdfPasswordProtectedError("PDF statement is encrypted and password-protected.")

    total_pages = len(reader.pages)
    if total_pages == 0:
        raise PdfMalformedError("PDF document contains zero pages.")

    # Phase 1: digital text-stream extraction.
    page_texts: List[str] = []
    for idx, page in enumerate(reader.pages):
        try:
            page_texts.append((page.extract_text() or "").strip())
        except Exception as exc:
            logger.warning("Error extracting text on page %d: %s", idx + 1, exc)
            page_texts.append("")

    total_chars = sum(len(t) for t in page_texts)
    is_scanned = False
    # `ocr_fn` returns None specifically when the OCR engine itself is
    # unavailable or crashed (see StatementExtractionService._run_ocr) vs
    # an empty string when it ran successfully but found no legible text —
    # tracked so the final error below can tell a genuinely low-quality
    # scan apart from "OCR isn't installed on this server," rather than
    # blaming the document either way.
    ocr_attempted_any_image = False
    ocr_engine_unavailable = False

    # Phase 2: zero digital characters -> OCR embedded page images.
    if total_chars == 0:
        ocr_page_texts: List[str] = []
        for idx, page in enumerate(reader.pages):
            parts: List[str] = []
            try:
                for img_obj in getattr(page, "images", []):
                    img_bytes = getattr(img_obj, "data", b"")
                    if img_bytes:
                        ocr_attempted_any_image = True
                        result = ocr_fn(img_bytes, "image/jpeg")
                        if result is None:
                            ocr_engine_unavailable = True
                        elif result.strip():
                            parts.append(result.strip())
            except Exception as exc:
                logger.warning("Error extracting page images on page %d: %s", idx + 1, exc)
            ocr_page_texts.append("\n".join(parts).strip())

        total_ocr_chars = sum(len(t) for t in ocr_page_texts)
        if total_ocr_chars > 0:
            page_texts = ocr_page_texts
            total_chars = total_ocr_chars
            is_scanned = True

    if total_chars == 0:
        if ocr_attempted_any_image and ocr_engine_unavailable:
            raise PdfUnreadableError(
                "This looks like a scanned statement, but the server's OCR engine "
                "(Tesseract) isn't installed, so it can't be read. Try a text-based "
                "export (downloaded directly from net-banking) instead."
            )
        raise PdfUnreadableError(
            "Scanned document contains no readable text layer or text resolution too low."
        )

    return page_texts, is_scanned

# Dynamic candidate paths generator for Tesseract OCR on Windows & POSIX
def _get_tesseract_candidate_paths() -> List[str]:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    return [
        os.environ.get("TESSERACT_CMD", ""),
        shutil.which("tesseract") or "",
        os.path.join(local_app_data, "Programs", "Tesseract-OCR", "tesseract.exe") if local_app_data else "",
        os.path.join(local_app_data, "Microsoft", "WindowsApps", "tesseract.cmd") if local_app_data else "",
        os.path.join(local_app_data, "Microsoft", "WindowsApps", "tesseract.exe") if local_app_data else "",
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
    ]


class StatementExtractionService:
    """
    Service for extracting raw text from uploaded statement documents (PDF and image formats).
    Manages transitions: RECEIVED -> PROCESSING -> COMPLETED or FAILED.
    """

    def __init__(self, custom_ocr_engine: Optional[OCREngineCallable] = None):
        self._custom_ocr_engine = custom_ocr_engine

    def set_ocr_engine(self, engine: Optional[OCREngineCallable]) -> None:
        """Allow injecting or swapping the OCR engine implementation (useful for tests/custom plugins)."""
        self._custom_ocr_engine = engine

    def get_ocr_status(self) -> StatementOCRStatusResponse:
        """
        Health and availability diagnostic for the local OCR engine.
        Inspects host environment for Tesseract binary, reports resolved path, version,
        and installation instructions if unavailable.
        """
        if self._custom_ocr_engine is not None:
            return StatementOCRStatusResponse(
                available=True,
                engine="custom_injected_ocr",
                version="injected_test_engine",
                binary_path=None,
                supported_formats=[
                    "image/png",
                    "image/jpeg",
                    "image/jpg",
                    "image/webp",
                    "image/heic",
                    "image/heif",
                    "scanned_pdf",
                ],
                message="Injected/mock OCR engine is active and ready for statement processing.",
                install_instructions=None,
            )

        resolved_path = self._resolve_tesseract_path()
        if resolved_path:
            try:
                import pytesseract  # type: ignore

                pytesseract.pytesseract.tesseract_cmd = resolved_path
                version_str = str(pytesseract.get_tesseract_version())
                return StatementOCRStatusResponse(
                    available=True,
                    engine="tesseract",
                    version=version_str,
                    binary_path=resolved_path,
                    supported_formats=[
                        "image/png",
                        "image/jpeg",
                        "image/jpg",
                        "image/webp",
                        "image/heic",
                        "image/heif",
                        "scanned_pdf",
                    ],
                    message="Local Tesseract OCR engine is available and ready for image and raster document processing.",
                    install_instructions=None,
                )
            except Exception as exc:
                logger.warning("Error initializing Tesseract at %s: %s", resolved_path, exc)

        return StatementOCRStatusResponse(
            available=False,
            engine="tesseract",
            version=None,
            binary_path=None,
            supported_formats=[
                "image/png",
                "image/jpeg",
                "image/jpg",
                "image/webp",
                "image/heic",
                "image/heif",
                "scanned_pdf",
            ],
            message=(
                "Local Tesseract OCR binary is not installed on this host. Digital PDF text extraction "
                "remains 100% functional. Scanned PDFs and image statements will safely report "
                "OCR_SCAN_UNREADABLE until Tesseract is installed."
            ),
            install_instructions={
                "windows_installer": "Download and install from https://github.com/UB-Mannheim/tesseract/wiki",
                "windows_winget": "winget install UB-Mannheim.TesseractOCR",
                "env_var": "Set TESSERACT_CMD=C:\\Program Files\\Tesseract-OCR\\tesseract.exe if installed in a custom path",
            },
        )

    def _resolve_tesseract_path(self) -> Optional[str]:
        """Locate the tesseract executable on the host system."""
        for candidate in _get_tesseract_candidate_paths():
            if candidate and os.path.isfile(candidate):
                if candidate.lower().endswith(".cmd") or candidate.lower().endswith(".bat"):
                    real_exe = os.path.join(
                        os.environ.get("LOCALAPPDATA", ""),
                        "Programs",
                        "Tesseract-OCR",
                        "tesseract.exe",
                    )
                    if os.path.isfile(real_exe):
                        return real_exe
                return candidate
        return None

    def run_ocr_on_image(self, raw_bytes: bytes, mime_or_format: str) -> Optional[str]:
        """Public wrapper around _run_ocr for callers outside this class
        (statement_parser_service.py's OCR-fallback path) — keeps that
        method's implementation private while giving other modules a
        proper entry point instead of reaching into `_run_ocr` directly."""
        return self._run_ocr(raw_bytes, mime_or_format)

    def _run_ocr(self, raw_bytes: bytes, mime_or_format: str) -> Optional[str]:
        """
        Execute OCR on raw image bytes.
        Uses injected OCR engine if present, or resolves host Tesseract binary.
        Returns extracted text string, or None if OCR is unavailable or fails.
        """
        # 1. Use injected/mock OCR engine if provided
        if self._custom_ocr_engine:
            try:
                return self._custom_ocr_engine(raw_bytes, mime_or_format)
            except Exception as exc:
                logger.warning("Custom OCR engine call failed: %s", exc)
                return None

        # 2. Use real Tesseract OCR if binary is available
        resolved_path = self._resolve_tesseract_path()
        if not resolved_path:
            return None

        try:
            import pytesseract  # type: ignore

            pytesseract.pytesseract.tesseract_cmd = resolved_path
            tessdata_dir = os.path.join(os.path.dirname(resolved_path), "tessdata")
            if os.path.isdir(tessdata_dir):
                os.environ["TESSDATA_PREFIX"] = tessdata_dir

            with Image.open(io.BytesIO(raw_bytes)) as img:
                text = pytesseract.image_to_string(img)
                return text
        except Exception as exc:
            logger.warning("Tesseract OCR execution failed: %s", exc)
            return None

    def extract_statement(
        self,
        upload_id: str,
        current_user_id: int,
        statement_store: Dict[str, Dict[str, Any]],
    ) -> StatementExtractionResponse:
        """
        Execute text extraction for an uploaded bank statement identified by upload_id.
        Validates ownership, guarantees status prerequisite (RECEIVED), transitions
        status, and stores extraction payload.
        """
        record = statement_store.get(upload_id)
        if not record:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Statement upload '{upload_id}' not found.",
            )

        # Enforce user ownership
        if record["user_id"] != current_user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not authorized to process this statement.",
            )

        # Enforce prerequisite status
        current_status = record.get("status")
        if current_status != StatementProcessingStatus.RECEIVED:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Cannot initiate extraction for statement with status '{current_status}'. "
                    f"Only statements in '{StatementProcessingStatus.RECEIVED.value}' status may be extracted."
                ),
            )

        # Transition status to PROCESSING
        now_iso = datetime.now(timezone.utc).isoformat()
        record["status"] = StatementProcessingStatus.PROCESSING
        record["message"] = "Statement document is currently being extracted."
        record["updated_at"] = now_iso

        raw_bytes: bytes = record.get("raw_bytes", b"")
        content_type: str = record.get("content_type", "").lower()
        filename: str = record.get("filename", "")

        # Size check defense
        if not raw_bytes or len(raw_bytes) == 0:
            return self._fail_extraction(
                record=record,
                upload_id=upload_id,
                error_code="DOCUMENT_EMPTY",
                detail="Statement file buffer is empty or missing.",
            )

        try:
            if "pdf" in content_type or filename.lower().endswith(".pdf"):
                return self._extract_pdf(upload_id=upload_id, record=record, raw_bytes=raw_bytes)
            else:
                return self._extract_image(
                    upload_id=upload_id,
                    record=record,
                    raw_bytes=raw_bytes,
                    content_type=content_type,
                )
        except Exception as exc:
            logger.exception("Unexpected error during statement extraction for %s: %s", upload_id, exc)
            return self._fail_extraction(
                record=record,
                upload_id=upload_id,
                error_code="EXTRACTION_ERROR",
                detail=f"Unexpected extraction failure: {str(exc)}",
            )

    def _extract_pdf(
        self,
        upload_id: str,
        record: Dict[str, Any],
        raw_bytes: bytes,
    ) -> StatementExtractionResponse:
        """
        Extract text page-by-page from a PDF document preserving page boundaries.
        Supports:
        - Digital PDFs: direct text stream extraction
        - Scanned/raster-only PDFs: page image extraction with OCR fallback

        Delegates the actual extraction algorithm to the standalone
        extract_pdf_page_texts() above — this method's own job is just
        mapping that to this class's upload_id/record-dict/response-schema
        workflow.
        """
        try:
            page_texts, is_scanned_pdf = extract_pdf_page_texts(raw_bytes, self._run_ocr)
        except PdfMalformedError as exc:
            return self._fail_extraction(
                record=record, upload_id=upload_id, error_code="PDF_MALFORMED", detail=str(exc)
            )
        except PdfPasswordProtectedError as exc:
            return self._fail_extraction(
                record=record, upload_id=upload_id, error_code="PDF_PASSWORD_PROTECTED", detail=str(exc)
            )
        except PdfUnreadableError as exc:
            return self._fail_extraction(
                record=record, upload_id=upload_id, error_code="OCR_SCAN_UNREADABLE", detail=str(exc)
            )

        total_pages = len(page_texts)
        pages: List[StatementPageText] = [
            StatementPageText(page_number=idx + 1, text=text, char_count=len(text))
            for idx, text in enumerate(page_texts)
        ]
        total_chars = sum(p.char_count for p in pages)
        raw_page_sections: List[str] = [
            f"--- Page {p.page_number} ---\n{p.text}" for p in pages
        ]

        combined_raw_text = "\n\n".join(raw_page_sections)
        now_iso = datetime.now(timezone.utc).isoformat()
        format_label = "application/pdf (scanned_ocr)" if is_scanned_pdf else "application/pdf"

        doc_metadata = StatementDocumentMetadata(
            format=format_label,
            page_count=total_pages,
            total_characters=total_chars,
            extracted_at=now_iso,
            file_size_bytes=len(raw_bytes),
        )

        # Transition to COMPLETED
        mode_str = "scanned OCR" if is_scanned_pdf else "digital stream"
        record["status"] = StatementProcessingStatus.COMPLETED
        record["message"] = f"Statement text extraction completed successfully ({total_pages} pages, {mode_str})."
        record["updated_at"] = now_iso
        record["error_detail"] = None
        record["extraction"] = {
            "upload_id": upload_id,
            "status": StatementProcessingStatus.COMPLETED,
            "raw_text": combined_raw_text,
            "pages": [p.model_dump() for p in pages],
            "total_pages": total_pages,
            "total_characters": total_chars,
            "document_metadata": doc_metadata.model_dump(),
            "message": record["message"],
            "error_detail": None,
        }

        return StatementExtractionResponse(
            upload_id=upload_id,
            status=StatementProcessingStatus.COMPLETED,
            raw_text=combined_raw_text,
            pages=pages,
            total_pages=total_pages,
            total_characters=total_chars,
            document_metadata=doc_metadata,
            message=record["message"],
            error_detail=None,
        )

    def _extract_image(
        self,
        upload_id: str,
        record: Dict[str, Any],
        raw_bytes: bytes,
        content_type: str,
    ) -> StatementExtractionResponse:
        """Validate image and extract text via OCR engine, preserving document boundaries."""
        try:
            stream = io.BytesIO(raw_bytes)
            with Image.open(stream) as img:
                img.verify()
                format_name = img.format or "image"
        except Exception as exc:
            return self._fail_extraction(
                record=record,
                upload_id=upload_id,
                error_code="IMAGE_MALFORMED",
                detail=f"Unable to decode statement image file or invalid format: {str(exc)}",
            )

        # Execute OCR extraction
        extracted_text = self._run_ocr(raw_bytes, content_type)
        cleaned_text = (extracted_text or "").strip()

        if not cleaned_text:
            return self._fail_extraction(
                record=record,
                upload_id=upload_id,
                error_code="OCR_SCAN_UNREADABLE",
                detail="OCR_SCAN_UNREADABLE: Resolution too low, unreadable text, or OCR engine unavailable for image scan.",
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        total_chars = len(cleaned_text)
        page_entry = StatementPageText(
            page_number=1,
            text=cleaned_text,
            char_count=total_chars,
        )
        combined_raw_text = f"--- Page 1 ---\n{cleaned_text}"

        doc_metadata = StatementDocumentMetadata(
            format=f"image/{format_name.lower()}",
            page_count=1,
            total_characters=total_chars,
            extracted_at=now_iso,
            file_size_bytes=len(raw_bytes),
        )

        record["status"] = StatementProcessingStatus.COMPLETED
        record["message"] = "Statement image OCR text extraction completed successfully."
        record["updated_at"] = now_iso
        record["error_detail"] = None
        record["extraction"] = {
            "upload_id": upload_id,
            "status": StatementProcessingStatus.COMPLETED,
            "raw_text": combined_raw_text,
            "pages": [page_entry.model_dump()],
            "total_pages": 1,
            "total_characters": total_chars,
            "document_metadata": doc_metadata.model_dump(),
            "message": record["message"],
            "error_detail": None,
        }

        return StatementExtractionResponse(
            upload_id=upload_id,
            status=StatementProcessingStatus.COMPLETED,
            raw_text=combined_raw_text,
            pages=[page_entry],
            total_pages=1,
            total_characters=total_chars,
            document_metadata=doc_metadata,
            message=record["message"],
            error_detail=None,
        )

    def _fail_extraction(
        self,
        record: Dict[str, Any],
        upload_id: str,
        error_code: str,
        detail: str,
    ) -> StatementExtractionResponse:
        """Safely transition statement to FAILED and record error details."""
        now_iso = datetime.now(timezone.utc).isoformat()
        record["status"] = StatementProcessingStatus.FAILED
        record["message"] = f"Extraction failed: {error_code}"
        record["error_detail"] = f"{error_code}: {detail}"
        record["updated_at"] = now_iso
        record["extraction"] = None

        return StatementExtractionResponse(
            upload_id=upload_id,
            status=StatementProcessingStatus.FAILED,
            raw_text="",
            pages=[],
            total_pages=0,
            total_characters=0,
            document_metadata=None,
            message=record["message"],
            error_detail=record["error_detail"],
        )


# Default singleton instance
extraction_service = StatementExtractionService()
