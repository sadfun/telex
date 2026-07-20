import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRecurrence, RecurrenceError } from "../src/automations/index.js";

describe("automation recurrence", () => {
  it("supports minutely intervals and returns occurrences strictly after the cursor", () => {
    const schedule = {
      rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
      startAt: "2026-07-21T10:00:00Z",
      timeZone: "UTC",
    };

    expect(nextOccurrence(schedule, new Date("2026-07-21T09:59:00Z"))?.toISOString()).toBe(
      "2026-07-21T10:00:00.000Z",
    );
    expect(nextOccurrence(schedule, new Date("2026-07-21T10:00:00Z"))?.toISOString()).toBe(
      "2026-07-21T10:05:00.000Z",
    );
  });

  it("supports hourly BYMINUTE constraints", () => {
    const schedule = {
      rrule: "FREQ=HOURLY;INTERVAL=2;BYMINUTE=15,45",
      startAt: "2026-07-21T08:15:00Z",
      timeZone: "UTC",
    };

    expect(nextOccurrence(schedule, new Date("2026-07-21T08:15:00Z"))?.toISOString()).toBe(
      "2026-07-21T08:45:00.000Z",
    );
    expect(nextOccurrence(schedule, new Date("2026-07-21T08:45:00Z"))?.toISOString()).toBe(
      "2026-07-21T10:15:00.000Z",
    );
  });

  it("keeps a daily wall-clock time across daylight-saving changes", () => {
    const schedule = {
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      startAt: "2026-03-28T08:00:00Z",
      timeZone: "Europe/Warsaw",
    };

    expect(nextOccurrence(schedule, new Date("2026-03-28T08:00:00Z"))?.toISOString()).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });

  it("does not emit the repeated wall-clock minute twice when daylight saving ends", () => {
    const schedule = {
      rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      startAt: "2026-10-24T00:30:00Z",
      timeZone: "Europe/Warsaw",
    };

    expect(nextOccurrence(schedule, new Date("2026-10-25T00:30:00Z"))?.toISOString()).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  it("supports weekly weekday lists", () => {
    const schedule = {
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30;WKST=MO",
      startAt: "2026-07-20T09:30:00Z",
      timeZone: "UTC",
    };

    expect(nextOccurrence(schedule, new Date("2026-07-20T09:30:00Z"))?.toISOString()).toBe(
      "2026-07-22T09:30:00.000Z",
    );
  });

  it("searches the full interval/weekday cycle", () => {
    const schedule = {
      rrule: "FREQ=DAILY;INTERVAL=20;BYDAY=WE;BYHOUR=9;BYMINUTE=0",
      startAt: "2026-07-20T09:00:00Z",
      timeZone: "UTC",
    };

    expect(nextOccurrence(schedule, new Date("2026-07-20T09:00:00Z"))?.toISOString()).toBe(
      "2026-10-28T09:00:00.000Z",
    );
  });

  it("rejects unsupported recurrence fields", () => {
    expect(() => parseRecurrence("FREQ=DAILY;BYSECOND=30")).toThrow(RecurrenceError);
  });

  it("rejects extra DTSTART lines instead of silently changing the anchor", () => {
    expect(() => parseRecurrence("DTSTART:20300101T100000Z\nRRULE:FREQ=DAILY")).toThrow(
      "exactly one RRULE line",
    );
  });

  it("rejects invalid calendar dates in UNTIL", () => {
    expect(() => parseRecurrence("FREQ=DAILY;UNTIL=20260231T000000Z")).toThrow(
      "real calendar instant",
    );
  });

  it("rejects cross-frequency filters whose next match can depend on a future DST phase", () => {
    expect(() =>
      nextOccurrence(
        {
          rrule: "FREQ=MINUTELY;INTERVAL=60;BYMINUTE=0",
          startAt: "2026-07-01T00:00:00Z",
          timeZone: "Australia/Lord_Howe",
        },
        new Date("2026-07-01T00:00:00Z"),
      ),
    ).toThrow("MINUTELY supports INTERVAL and UNTIL only");
  });

  it("aborts dense long-horizon rules at a bounded work limit", () => {
    const allHours = Array.from({ length: 24 }, (_value, index) => index).join(",");
    const allMinutes = Array.from({ length: 60 }, (_value, index) => index).join(",");

    expect(() =>
      nextOccurrence(
        {
          rrule: `FREQ=DAILY;INTERVAL=997;BYDAY=FR;BYHOUR=${allHours};BYMINUTE=${allMinutes}`,
          startAt: "2026-07-20T00:00:00Z",
          timeZone: "UTC",
        },
        new Date("2026-07-20T00:00:00Z"),
      ),
    ).toThrow("bounded recurrence work limit");
  });
});
