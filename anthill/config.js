// Anthill map config.
//
// The map reads a LIVE, read-only Google Sheet via the gviz endpoint. This
// works because the sheet is shared "anyone with link: viewer" — it contains
// ONLY public listing data (no owner PII; that lives in a separate private
// sheet). The sheet id below is the read-only "credential": it grants view
// access to public real-estate data and nothing else.
window.ANTHILL_CONFIG = {
  // Public map sheet — "Anthill — SF Group House Search".
  sheetId: "17xEBy-QUxXaH1vem_B_3Nh1KvPp3YwqXrbHliM3PQPs",
  sheetTab: "Listings",
  sheetUrl: "https://docs.google.com/spreadsheets/d/17xEBy-QUxXaH1vem_B_3Nh1KvPp3YwqXrbHliM3PQPs/edit",

  // SF center + sensible zoom.
  center: [37.7749, -122.4380],
  zoom: 12.4,

  // Marker color per Category (falls back to grey).
  categoryColors: {
    "8+BR house": "#e4572e",
    "7BR house": "#f3a712",
    "Multi-family": "#4c9f70",
    "6BR house (flex)": "#3f7cac",
  },
};
