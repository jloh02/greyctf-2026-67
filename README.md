<!--
Copy this README.md when starting a new challenge.

Required sections are Name, Description, Author, and Flag.

Read the Whale section below if the challenge needs per-team/per-user instances.
-->

# Name
67

# Description

Can you 67 on a merry christmas?

# Author
jloh02

# Flag
`grey{676676767676767_0110_0111_0110_0111_736978736576656E}`

# Challenge

Play flappy bird with 67 hand gestures

# Diagnostics

The hand-tracking diagnostic route is disabled by default. Start the frontend
with `DIAGNOSTIC_PAGE=true` to expose `/diagnostics`:

```sh
DIAGNOSTIC_PAGE=true npm run start:frontend
```

Open `http://127.0.0.1:4173/diagnostics` to view live hand-height, delta, threshold,
cross-count, and jump-trigger markers.

For Docker Compose, pass `DIAGNOSTIC_PAGE=true`; Compose forwards it only to the
frontend container.
