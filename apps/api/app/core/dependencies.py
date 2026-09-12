"""
FastAPI dependencies for authentication, token validation, and user identity extraction.
Spec: DATABASE_INTEGRATION_REQUIREMENTS.md §5.1, §7 Step 4.
"""

from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User
from app.repositories import user_repository
from app.services.session_service import SessionService

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    auth_header: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Extract and validate the Bearer token from the Authorization header.

    The app issues two different token shapes depending on the auth flow:
    a short-lived JWT from /auth/signup (decoded here directly), and an
    opaque, DB-backed session token from /auth/verify-otp, /auth/login,
    etc. (SessionService.create_session) — the token every real logged-in
    mobile session actually persists and sends afterward. A JWT-only check
    here 401s every real user, since they're never carrying a JWT past
    their first, pre-verification request. Both are tried before failing.

    Returns authenticated User model or raises HTTP 401 Unauthorized.
    """
    if not auth_header or not auth_header.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please provide a valid Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_header.credentials

    try:
        payload = decode_access_token(token)
        user_id_str = payload.get("sub")
        if not user_id_str:
            raise ValueError("Token claim invalid: missing subject ID.")
        user = user_repository.get_user_by_id(db, int(user_id_str))
        if user is not None:
            return user
    except (JWTError, ValueError):
        pass

    is_valid, session, _err_msg = SessionService.validate_session_token(db=db, raw_token=token)
    if is_valid and session is not None:
        user = user_repository.get_user_by_id(db, session.user_id)
        if user is not None:
            return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired access token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_optional_current_user(
    auth_header: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Extract authenticated user if a valid Bearer token is provided, otherwise return None without error."""
    if not auth_header or not auth_header.credentials:
        return None
    try:
        return get_current_user(auth_header=auth_header, db=db)
    except HTTPException:
        return None
