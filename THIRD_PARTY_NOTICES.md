# Third-party notices

The project source code is MIT-licensed. The following data and SDKs retain
their own terms. This file will be expanded with exact pinned versions before
any data is bundled or distributed.

## JMdict and KANJIDIC2

JMdict supplies word glosses; KANJIDIC2 supplies English character meanings and
Japanese on/kun readings. Local setup fetches the current feeds and records
retrieval dates and archive SHA-256 in ignored `analysis-service/.data/manifest.txt`.
Run `analysis-service/scripts/setup-data.sh` regularly to refresh them; the
normal launcher uses `--missing` to avoid downloading existing files again.
KANJIDIC2 documentation: https://www.edrdg.org/wiki/KANJIDIC_Project.html


Copyright belongs to the Electronic Dictionary Research and Development Group.
Use is subject to the EDRDG dictionary license, including attribution and
share-alike requirements for adapted data. The EDRDG license permits commercial
use when its conditions are met:

https://www.edrdg.org/edrdg/licence.html

## KanjiVG

KanjiVG is copyright Ulrich Apel and contributors and is released under
Creative Commons Attribution-ShareAlike 3.0:

https://github.com/KanjiVG/kanjivg

## Sudachi

Sudachi source code is Apache License 2.0. Sudachi dictionaries are separately
licensed resources and must be pinned and recorded separately:

https://github.com/WorksApplications/Sudachi

## Google ML Kit

ML Kit is a third-party SDK used under Google's applicable terms. No ML Kit
model files are redistributed by this repository.
