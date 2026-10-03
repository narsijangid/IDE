# OLKIL Pocket

Phone app for the OLKIL VS Code extension. The phone sends a task. The computer runs it.

## Run

```bash
cd olkil-pocket
npm start
```

Then open Expo Go on Android, or `npm run android`.

## Before it works

1. On the computer: reload Cursor, sign in to OLKIL, command **OLKIL: Toggle Pocket**. A 6-digit code appears.
2. In the app: Continue with Google, same account as the PC, enter that code.
3. Firebase project `olkil-2c8ac` must allow the signed-in user to read and write `users/{uid}/**`. Rules are in `firestore.rules` and `storage.rules`. Deploy them in the Firebase console if Pocket says permission denied.

Desktop OLKIL Pocket must be On. If the PC is asleep, the task stays queued.
