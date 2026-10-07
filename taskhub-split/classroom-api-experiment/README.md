# TaskHub Classroom API experiment

This folder tracks the source and regression tests for a separate Classroom API
verification project. It follows the same five-sheet API/Gmail data model as
the production app and adds a probe page for API-only inspection and saves.

The `?classroomApiTest=1` page has a read-only probe and a separate API-only
save action. The read-only probe lists active courses, published coursework,
and the signed-in student's submission states without writing a spreadsheet.
The API-only save action writes the complete Classroom snapshot to that user's
private workbook and never calls Gmail. The regular app treats a complete
Classroom API coursework snapshot as authoritative for assignment cards, then
runs Gmail synchronization for supplemental Classroom mail and inCampus
notifications. Gmail's existing 15-minute trigger remains; a separate hourly
trigger refreshes Classroom coursework when the site is closed. The manual
Update action runs API first and Gmail second and keeps the current screen and
existing cards visible until the result is ready.

The API data is saved into the five functional tabs below:

| Tab | Contents |
| --- | --- |
| `授業` | Course ID, name, section, teacher names, URL, state, and fetch time |
| `Classroom課題` | Published task metadata, links/materials, topic, release/create/update times, Japan-local deadline, TaskHub status, and fetch time |
| `inCampus通知` | One physical tab containing Gmail notices and extension-extracted report details, tagged with a record type and kept in separate column groups |
| `提出状況` | The signed-in student's state, submission time, late/returned flags, and published grade; never answer text or submitted files |
| `補足通知` | Gmail Classroom assignment emails for fast first-pass display, plus announcements, materials, and return notices that the API does not provide |

The `inCampus通知` tab stores Gmail fields in the original notification
columns and extraction fields in prefixed columns. Each record has its own row
and is marked as `gmail` or `extract`. The extension adapter exposes only extraction rows to the
existing parser and writer, so Gmail retention and sorting cannot overwrite
extracted fields. On first access, the old `inCampus抽出` tab is copied into
`inCampus通知`; it is removed only after the copy is verified and only if it
has no extra unknown columns or data. At display time, an extraction is joined
to a Gmail notice only when the normalized course and title match exactly and
the report URL identifies one unambiguous report. The Gmail notice remains the
visible record and keeps its original message ID, receive time, and link.

Existing `Classroom通知` and `通知一覧` tabs are retained as recoverable
archives. Eligible legacy Classroom mail is copied to `補足通知` with
message-ID deduplication. New Gmail assignment emails continue to be saved for
the 15-minute first pass. Once a matching API task exists, the UI collapses
the email and API data into one API-owned card: API deadline and submission
state win, while the card retains the Gmail message ID, received time, and a
button to open the source email. Unmatched assignment emails remain visible
until the API later finds their task or normal Gmail retention expires them.
Classroom `新しいお知らせ` mail remains available to the university-notice
view through Gmail.

Classroom's `dueDate` and `dueTime` fields are UTC. The app converts timed
deadlines to Japan time before saving or displaying them; a date without an API
time defaults to 23:59. Submission rows are selected by the signed-in
Classroom user ID, and `TURNED_IN`, `RETURNED`, and
`STUDENT_EDITED_AFTER_TURN_IN` are treated as submitted.

The API snapshot never deletes Gmail source rows. In test case mode, real
API/Gmail syncs still save to the user's private workbook while the screen
continues to display the fictional test workbook.

The script is restricted to users in the Senshu domain and runs as the user
accessing it. Keep its Script ID separate from the production project.

The project and deployment IDs are kept in the local, ignored `.clasp.json`
file and are intentionally excluded from this public repository. The deployed
verification app is restricted to Senshu accounts and runs as the signed-in
user. Check the current deployment with the local clasp wrapper before use.

Use the page's `APIのみ保存同期（Gmailなし）` button to refresh the signed-in
user's saved API rows without running Gmail. The result shows each saved due
time, submission state, and TaskHub completion classification.

Run the local API probe and authoritative-sync regression checks with:

```sh
node tests/classroom-api-experiment.test.cjs
node tests/classroom-api-sync.test.cjs
```

## Push and update this Apps Script project

The repository root pins `@google/clasp` at the version in `package.json` and
`pnpm-lock.yaml`. Use the experiment wrapper so commands run from this folder
and use this project's `.clasp.json`; the root-level clasp commands target the
separate canonical project.

```sh
./local-dev/clasp-experiment.sh show-file-status
./local-dev/clasp-experiment.sh push
./local-dev/clasp-experiment.sh deployments
```

The wrapper adds the Codex-bundled Node.js runtime when the shell has no `node`
on `PATH`. OAuth credentials remain in the user's clasp config outside this
repository. Review `show-file-status` before each push; `.claspignore` excludes
this README, local test files, and project settings from Apps Script uploads.

To keep the current test URL, create a version and update the existing
deployment whose description identifies the API experiment:

```sh
./local-dev/clasp-experiment.sh create-version "API UTC deadlines, submission state, and JST retention fix"
./local-dev/clasp-experiment.sh update-deployment <deployment-id> --versionNumber <version> --description "API UTC deadlines, submission state, and JST retention fix"
```
