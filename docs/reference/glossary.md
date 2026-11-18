# LicenX glossary

| Term | Meaning in this project |
| --- | --- |
| **Application / app scope** | Registered client product to which a license may be bound; identified by an app slug/ID |
| **License key** | Credential validated by the licensing service; not the user's admin password |
| **Security PIN** | Separate four-digit code used for public device-control operations |
| **HWID** | Client device fingerprint identifier, used for binding and device limits |
| **Device binding** | Association of licensed key/device, managed by transactional server policy |
| **Lease** | Maximum trust interval for an authenticated licensed device between permitted updates |
| **Heartbeat / ping** | SDK renewal/check interaction with the license server |
| **Offline grace** | Limited policy window; not permission to operate with no trusted prior validation |
| **Signed response** | Server-provided license result verified against a trusted public key |
| **Site Settings** | Editable branding, links, SEO and public policy fields |
| **Public catalog** | Ordered published navigation links and external tool cards |
| **Buy License CTA** | Configured external call-to-action link, not an internal checkout |
| **Admin API key** | Hashed/scoped private server credential for controlled backend operations |
| **Restricted partner check** | Read-only server-to-server license membership endpoint |
| **R2** | Cloudflare object-storage service used for selected public/private assets and backups |
| **Full backup** | Encrypted database+managed-asset archive requiring a separate recovery key |
| **Recovery key** | Sensitive 32-byte key that must be protected off-host |
| **Admin WSS** | Optional authenticated admin WebSocket update channel |
| **SocketCore** | Separate optional ticketed realtime license/session transport |
| **HF-01** | Site Settings Save compatibility hotfix; deployed app-only at the last recorded acceptance |
| **Scope Lock** | Approved boundary of files, behavior, tests and environments for a specific task |
| **Production accepted** | Observed acceptance within stated test scope, not universal proof of all functions |
| **Private notes** | Locally ignored `notes/` forensic/progress artifacts, never part of public Git documentation |

[Documentation home](../index.md).