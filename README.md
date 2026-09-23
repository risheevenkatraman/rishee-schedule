# R&R Calendar

A private calendar and finance tracker for two people sharing one password-protected workspace.

## Features

- Monthly calendar with multi-day task timelines, notes, and completion status.
- Optional progress bars with editable percentages.
- Private document attachments up to 20 MB per file.
- Finance entries with amounts, Paid/Unpaid status, and Org, Personal/Shopping, Family, or Marriage/Future tags.
- Purple, white, and soft-orange interface with a particle-heart welcome screen.

## Implementation stack

- HTML, CSS, and JavaScript frontend.
- Node.js 24 HTTP API with shared-password authentication and session cookies.
- SQLite for local storage.
- Next.js and React for the statically exported particle-heart component.
- AWS Amplify Hosting, DynamoDB, S3, and Secrets Manager for cloud deployment.
- Prettier, Node.js tests, and GitHub Actions for formatting and validation.
