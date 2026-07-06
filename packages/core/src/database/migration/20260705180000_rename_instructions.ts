import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260705180000_rename_instructions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_entry\` RENAME TO \`instruction_entry\``)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` RENAME TO \`instruction_checkpoint\``)
      yield* tx.run(`
        CREATE TABLE \`instruction_file\` (
          \`session_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`content\` text NOT NULL,
          \`message_seq\` integer NOT NULL,
          \`discovered_seq\` integer NOT NULL,
          \`position\` integer NOT NULL,
          PRIMARY KEY(\`session_id\`, \`path\`),
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON UPDATE no action ON DELETE cascade
        )
      `)
      yield* tx.run(`
        UPDATE \`event\`
        SET \`type\` = 'session.instructions.updated.1'
        WHERE \`type\` = 'session.context.updated.1'
      `)
    })
  },
} satisfies DatabaseMigration.Migration
