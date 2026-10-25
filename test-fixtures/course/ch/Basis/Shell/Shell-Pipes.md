title: Pipelines und Umlenkung
stage: alpha
timevalue: 1.5
difficulty: 2
explains: Pipeline, stdin
assumes: Shell-Einstieg
---
[SECTION::goal::trial]
Ich verstehe [TERMREF2::Pipeline::-s] und Umlenkung.
[ENDSECTION]

[SECTION::instructions::loose]

Lesen Sie [HREF::https://www.gnu.org/software/bash/manual/html_node/Redirections.html].

[EC] Zählen Sie die Zeilen aller Markdown-Dateien mit `cat *.md | wc -l`.

[EQ] Warum erscheint die Fehlermeldung trotz Umlenkung auf dem Terminal?

[EC] Lenken Sie `stderr` nach `/tmp/err` um.

[NOTICE]
Das Idiom `echo "Ich bin datei1" >datei1` ist praktisch.
[ENDNOTICE]

<!-- sedrila: macros off -->
```bash
arr[INDEX]=42
echo ${arr[INDEX]}
```
<!-- sedrila: macros off end -->

[EQ] Was bewirkt [EREFC::2] genau?

[ENDSECTION]

[SECTION::submission::trace]
[INCLUDE::/_include/Submission-Kommandoprotokoll.md]
[ENDSECTION]

[INSTRUCTOR::Kommandoprotokoll]
[PROT::ALT:Shell-Pipes.prot]
[INCLUDE::ALT:]
[ENDINSTRUCTOR]
