# Security

Never include provider API keys, Firebase service-account private keys, encryption keys, or user databases in issues or pull requests. Use environment variables or your deployment platform's secret store. Firebase web configuration is public client configuration; it does not replace authentication or database authorization rules.

Keep `WORKFLOW_ENCRYPTION_KEY` stable and backed up separately from the database. Changing it makes stored provider credentials unreadable. Firestore snapshot access must remain server-only.

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability** when available. If private reporting is unavailable, contact the maintainer privately before sharing exploit details. Rotate exposed credentials: deleting a file in a later commit does not remove it from repository history.
