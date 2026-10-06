# Coding job

1. Read the approved plan, the feature README and the listed lessons. The README is how the feature works
   today. The plan is what must change.
2. Check the whole journey, not only the changed line. Search the repository for code that already does part
   of this and reuse it.
3. Implement the smallest change that fully meets every acceptance check. Stay inside the plan's scope.
4. Run the project's build and unit tests yourself and fix failures. The pipeline will run them again.
5. Update the feature README so it describes the NEW behaviour. Keep it short and factual: where it lives,
   current behaviour, rules and decisions, known limits. If the behaviour did not change, explain why in
   park.json docsUnchangedReason.
6. Write park.json and qa.json into the artifacts folder:
   - park.json: plain-English summary, every changed or created file that still exists, deletedFiles for every removed file, honest limitations. Never put a deleted file in files.
   - qa.json: real steps with assert lines. Every acceptance check (AC1, AC2 ...) must be covered by a step
     that asserts it, with "covers": ["AC1"]. Cover related surfaces too.
7. On a redo, also write lesson.json (title, symptom, rootCause, rule, keywords) so the mistake is not repeated.
8. Stop. Do not commit or deploy.

If the ticket cannot be built without a decision or missing information, write needinfo.json instead.
