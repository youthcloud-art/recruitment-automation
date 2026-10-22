# Bundled OCR language data

`chi_sim.traineddata` and `eng.traineddata` are the fast LSTM models from
[tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd),
commit `87416418657359cb625c412a48b6e1d6d41c29bd`, distributed under the
Apache License 2.0 in `LICENSE`.

SHA-256:

- `chi_sim.traineddata`: `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`
- `eng.traineddata`: `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`

The company release script verifies both files and starts a real OCR worker
before switching the running service. OCR never downloads language files at
candidate collection time.
