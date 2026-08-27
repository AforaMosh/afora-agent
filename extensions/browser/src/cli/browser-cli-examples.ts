/**
 * Help examples shown by the Browser CLI root command.
 */
/** Core Browser CLI examples for lifecycle and inspection commands. */
export const browserCoreExamples = [
  "afora browser status",
  "afora browser start",
  "afora browser start --headless",
  "afora browser stop",
  "afora browser tabs",
  "afora browser open https://example.com",
  "afora browser focus abcd1234",
  "afora browser close abcd1234",
  "afora browser screenshot",
  "afora browser screenshot --full-page",
  "afora browser screenshot --ref 12",
  "afora browser snapshot",
  "afora browser snapshot --format aria --limit 200",
  "afora browser snapshot --efficient",
  "afora browser snapshot --labels",
];

/** Browser CLI examples for interaction/action commands. */
export const browserActionExamples = [
  "afora browser navigate https://example.com",
  "afora browser resize 1280 720",
  "afora browser click 12 --double",
  "afora browser click-coords 120 340",
  'afora browser type 23 "hello" --submit',
  "afora browser press Enter",
  "afora browser hover 44",
  "afora browser drag 10 11",
  "afora browser select 9 OptionA OptionB",
  "afora browser upload /tmp/afora/uploads/file.pdf",
  "afora browser upload media://inbound/file.pdf",
  'afora browser fill --fields \'[{"ref":"1","value":"Ada"}]\'',
  "afora browser dialog --accept",
  'afora browser wait --text "Done"',
  "afora browser evaluate --fn '(el) => el.textContent' --ref 7",
  "afora browser evaluate --fn 'const title = document.title; return title;'",
  "afora browser console --level error",
  "afora browser pdf",
  "afora browser batch --actions-file plan.json",
  'afora browser batch --actions \'[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]\'',
  "afora browser batch --actions-file plan.json --continue",
];
