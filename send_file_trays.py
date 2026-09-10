"""Send the Mid-Century File Trays 3D HTML plan as an email attachment.

Reuses the same SMTP config pattern as grades_emailer.py, pulling credentials
from the facts-stats/.env file at runtime (SMTP_HOST/PORT/USERNAME/PASSWORD/
FROM/TO). No credentials are hardcoded here.
"""

import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"
ATTACHMENT = Path("/home/ahepworth/mid-century-file-trays.html")


def _load_dotenv():
    if not ENV_PATH.is_file():
        return
    with open(ENV_PATH, encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.lower().startswith("export "):
                line = line[7:].strip()
            key, sep, value = line.partition("=")
            if not sep:
                continue
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _cfg(name, default=None):
    return os.getenv(name, default)


def main():
    _load_dotenv()

    host = _cfg("SMTP_HOST")
    port = int(_cfg("SMTP_PORT", "587"))
    username = _cfg("SMTP_USERNAME")
    password = _cfg("SMTP_PASSWORD")
    from_addr = _cfg("SMTP_FROM")
    to_addr = _cfg("SMTP_TO")
    use_tls = str(_cfg("SMTP_USE_TLS", "true")).lower() == "true"
    use_ssl = str(_cfg("SMTP_USE_SSL", "false")).lower() == "true"

    if not host or not from_addr or not to_addr:
        raise SystemExit(
            "SMTP not fully configured. Set SMTP_HOST, SMTP_FROM, and SMTP_TO in facts-stats/.env"
        )

    if not ATTACHMENT.is_file():
        raise SystemExit(f"Attachment not found: {ATTACHMENT}")

    msg = EmailMessage()
    msg["Subject"] = "Mid-Century File Trays - 3D Build Plan"
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(
        "Open the attached HTML file in a browser (e.g. xdg-open) to view the "
        "interactive 3D model. Drag to rotate, scroll to zoom, hover parts for "
        "dimensions.\n\nThis email was sent automatically from your SMTP config."
    )

    msg.add_attachment(
        ATTACHMENT.read_bytes(),
        maintype="text",
        subtype="html",
        filename=ATTACHMENT.name,
    )

    context = ssl.create_default_context()
    if use_ssl:
        with smtplib.SMTP_SSL(host, port, context=context) as server:
            if username and password:
                server.login(username, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port) as server:
            if use_tls:
                server.starttls(context=context)
            if username and password:
                server.login(username, password)
            server.send_message(msg)

    print(f"Sent to {to_addr}")


if __name__ == "__main__":
    main()
