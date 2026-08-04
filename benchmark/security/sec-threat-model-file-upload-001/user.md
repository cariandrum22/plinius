A product is adding a feature that lets users upload files (images, PDFs, and office documents), which the backend then processes (generates thumbnails, extracts text for search) and serves back to other users. You are asked to threat-model this feature before implementation.

Context:
- Uploads go to a cloud object store; a worker service processes them; processed results are served from a CDN.
- Some files are shared publicly via links; others are private to a workspace.
- Processing uses third-party libraries for image and document parsing.
- The team wants to know "what could go wrong and what we must build".

Produce a threat model for this feature. Identify the assets and trust boundaries, then enumerate the realistic threats using a systematic method, covering at least: malicious file content and parser exploitation, content-type and extension confusion, files that trigger server-side requests or resource exhaustion, stored cross-site scripting via served files, access-control mistakes between public and private files, and metadata/privacy leakage. For each significant threat, give a concrete scenario and a proportionate mitigation. Prioritize the threats by realistic risk and state which mitigations are must-haves before launch versus later hardening.
