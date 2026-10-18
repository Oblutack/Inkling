import axios from "axios";
import { API_URL } from "./api";

// The time zone of this browser, as an IANA name ("Europe/Sarajevo"), or "" when it cannot be told.
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

const SYNCED = "inkling.timeZoneSynced";

// Lets the server know this browser's time zone, once per tab session, so that "today" (flashcards due, the streak) and
// "8 in the morning" (reminders) mean the person's own. Quiet when it fails: nothing depends on it working.
export async function syncTimeZone(): Promise<void> {
  const zone = browserTimeZone();
  if (!zone) return;
  try {
    if (sessionStorage.getItem(SYNCED) === zone) return;
  } catch {
    // no session storage: do it each time
  }
  try {
    const current = await axios.get<{ timeZone: string }>(`${API_URL}/account/email-preferences`);
    if (current.data.timeZone !== zone) await axios.put(`${API_URL}/account/email-preferences`, { timeZone: zone });
    try {
      sessionStorage.setItem(SYNCED, zone);
    } catch {
      // fine
    }
  } catch {
    // The server keeps the old zone (or UTC): the day may be off by a few hours, nothing worse.
  }
}
