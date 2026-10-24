# Task attachments

Use the plus button in the message composer to attach files. Selected files stay in the draft until removed or successfully submitted; a failed submission keeps both the message and files available for retry. Attachments can be submitted without text.

Supported formats are PNG, JPEG, and WebP images, plus UTF-8 TXT, Markdown, CSV, and JSON text. Images are passed to the Codex v2 app-server as user image inputs with a data URL in `url` (for example, `{ type: "image", url: "data:image/png;base64,..." }`); text is included as labeled content. This is the app-server input shape, not the Responses API's `image_url` content item. PDF, office documents, audio, video, SVG, and other types are rejected. There is no OCR, transcription, or conversion.

Limits are five files, 5 MiB per file, and 12 MiB total. The server checks MIME type, byte count, base64 encoding, UTF-8 text, and image signatures. Display names are reduced to basenames; client filesystem paths are never read. Attachments are stored with the local task pass and passed to the router and execution role for that pass. They are untrusted task data, not instructions or permission to access other files. Treat local task state as sensitive and do not attach secrets unless needed.

The adapter is checked against the installed app-server's request parser so an incompatible image field fails before inference. Provider/model image understanding still depends on the installed runtime; a successful schema check alone does not establish live inference behavior.
