# Agent chat loop (message → actions → message …)

## What the screenshots show
One user prompt starts a working loop. The agent talks, then acts, then talks again, until the job is done:

```text
User: prompt
AI:   "I'll read the files and plan the structure."
      [3 actions: search, read, think]        (collapsed chips)
AI:   "I understand the layout. Next I'll create the screens."
      [6 actions: read, read, create, create, edit, image]
AI:   "Screens are in place. Running checks."
      [5 actions · 1 fixed]                  (a failed step that got fixed)
      Worked for 2 minutes
AI:   "Done. Your app now has … Open the preview."
      Checkpoint saved · Rollback
```

## How it will work
1. **Agent loop on the backend.** One user prompt runs up to about 8 rounds. In each round the AI returns a short message plus a list of steps: read file, list files, create file, edit file, delete file, think, check. It ends with a final summary.
2. **Steps run on the real project files.** Each round sends the current file list (and any files the AI asked to read) to the backend. The app runs the file steps in the project's workspace, so the Files tab and Preview change for real.
3. **Checks and fixes.** After the edits, a "check" step generates the preview output. If it fails, the error goes back to the AI in the next round, it fixes the problem, and the group shows "· 1 fixed".
4. **Live timeline.** Each AI message and each action group shows up as soon as its round finishes. You see the "Thinking…" row between rounds, then "Worked for N minutes", the final reply, and a checkpoint with Rollback that restores the files from before the run.
5. **Plan mode** keeps the loop to messages and read/think steps only, with no file changes.
6. **Stop** cancels the loop between rounds. Steps that already ran are kept, and the checkpoint can undo them.

## Technical details
- Worker: new `agentStep` RPC in `api/sync.ts` → `orchestrator.server.ts` `runAgentRound({ history, files, readResults, lastErrors })`. The AI must answer in JSON: `{ message, actions: [{ kind, path?, content?, find?, replace? }], done }`. Responses that aren't valid JSON get one repair attempt, then the round fails with a clear error. Only the user prompt and the AI messages are saved as chat messages; actions are not.
- Client: `src/lib/agent/index.ts` runs the loop. It takes a snapshot before the first round, calls `agentStep`, applies actions through the WorkspaceStore (`beginAction`/`endAction` for each step, using the existing kinds read/search/create/edit/fix/test/think), runs `generateOutput` for the check step, then sends the results back for the next round.
- The timeline groups actions by agent round (a `roundId` on each action) instead of "consecutive actions", so groups sit between the AI messages. Add a "Worked for N min" status item and a "· N fixed" counter in ActionGroup.
- Model routing stays the same (Speed/Flash/Heavy + depth). Each round uses its own time limit. Balanced/Deep are slow at the provider, so runs on those depths can take several minutes.
