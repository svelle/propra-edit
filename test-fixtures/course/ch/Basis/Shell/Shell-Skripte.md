title: Einfache Shell-Skripte
stage: draft
timevalue: 2.0
difficulty: 3
assumes: Shell-Pipes
requires: Shell-Einstieg
---
[SECTION::goal::product]
Ich schreibe ein kleines [TERMREF::Bash]-Skript.
[ENDSECTION]

[SECTION::instructions::loose]

[ER] Das Skript nimmt einen Dateinamen als [TERMREF::Argument] entgegen.

[ER] Das Skript gibt die Anzahl der Zeilen aus.

[WARNING]
Vergessen Sie nicht `chmod +x`.
[ENDWARNING]

[FOLDOUT::Beispielskript]
```bash
#!/bin/bash
wc -l "$1"
```
[ENDFOLDOUT]

[ENDSECTION]

[SECTION::submission::program]
Geben Sie das Skript ab.
[ENDSECTION]

[INSTRUCTOR::Skript prüfen]
Siehe [TREEREF::/Basis/Shell/zeilen.sh].
[ENDINSTRUCTOR]
