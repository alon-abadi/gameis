// settings.js
module.exports = {
  // How many months back (including the current month) count as "new"
  NEW_PAST_MONTHS: 3,

  // How many months forward count as "upcoming"
  UPCOMING_FUTURE_MONTHS: 6,

  // Which field is the unique ID of a game in your JSON objects
  // Change this to "id" if that's what you use.
  ID_FIELD: "SteamID",

  // Optional: used only for logging / your own clarity
  TIMEZONE: "Asia/Jerusalem",
};
