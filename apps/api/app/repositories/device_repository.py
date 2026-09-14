from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device


def get_device(db: Session, *, user_id: int, device_hash: str) -> Optional[Device]:
    return (
        db.query(Device)
        .filter(Device.user_id == user_id, Device.device_hash == device_hash)
        .first()
    )


def list_device_hashes(db: Session, *, user_id: int) -> list[str]:
    """All device_hash values this user has previously transacted from —
    used by risk_service.py to populate the fraud model's `known_devices`
    feature with the user's real device history instead of an empty list."""
    rows = db.query(Device.device_hash).filter(Device.user_id == user_id).all()
    return [r[0] for r in rows]


def create_device(
    db: Session,
    *,
    user_id: int,
    device_hash: str,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
) -> Device:
    device = Device(
        user_id=user_id, device_hash=device_hash, device_name=device_name, device_type=device_type
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def touch_last_seen(
    db: Session,
    device: Device,
    *,
    device_name: Optional[str] = None,
    device_type: Optional[str] = None,
) -> Device:
    device.last_seen = datetime.now(timezone.utc)
    # A later, more informative report (e.g. the client finally sends a
    # name) can fill in what an earlier request left blank; never overwrite
    # a known name with a blank one.
    if device_name:
        device.device_name = device_name
    if device_type:
        device.device_type = device_type
    db.add(device)
    db.commit()
    db.refresh(device)
    return device
