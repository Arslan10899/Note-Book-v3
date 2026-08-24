// ---------- Public holidays: Pakistan + USA ----------
// Fixed dates + rule-based US floating days + year-mapped Islamic (lunar) dates.
const PK_FIXED = [
  [2, 5, "Kashmir Day"],
  [3, 23, "Pakistan Day"],
  [5, 1, "Labour Day"],
  [8, 14, "Independence Day"],
  [11, 9, "Iqbal Day"],
  [12, 25, "Quaid-e-Azam Day"],
];

// Islamic (lunar) observances in Pakistan — approximate, verified per year.
// Format: [month, day, name, extraDays] where the holiday spans 1+extraDays.
const PK_LUNAR = {
  2024: [
    [4, 11, "Eid ul-Fitr", 2],
    [6, 17, "Eid ul-Adha", 2],
    [7, 17, "Ashura", 1],
    [9, 16, "Eid Milad un-Nabi", 0],
  ],
  2025: [
    [3, 31, "Eid ul-Fitr", 2],
    [6, 7, "Eid ul-Adha", 2],
    [7, 6, "Ashura", 0],
    [9, 5, "Eid Milad un-Nabi", 0],
  ],
  2026: [
    [3, 20, "Eid ul-Fitr", 2],
    [5, 27, "Eid ul-Adha", 2],
    [6, 25, "Ashura", 0],
    [8, 26, "Eid Milad un-Nabi", 0],
  ],
  2027: [
    [3, 10, "Eid ul-Fitr", 2],
    [5, 17, "Eid ul-Adha", 2],
    [6, 15, "Ashura", 0],
    [8, 15, "Eid Milad un-Nabi", 0],
  ],
};

const pad2 = (n) => String(n).padStart(2, "0");

function nthWeekdayOfYear(y, month, weekday, n) {
  const d = new Date(y, month - 1, 1);
  const shift = (weekday - d.getDay() + 7) % 7;
  return 1 + shift + (n - 1) * 7;
}

function lastWeekdayOfMonth(y, month, weekday) {
  const d = new Date(y, month, 0);
  const back = (d.getDay() - weekday + 7) % 7;
  return d.getDate() - back;
}

function usHolidays(y) {
  return [
    [1, 1, "New Year's Day"],
    [1, nthWeekdayOfYear(y, 1, 1, 3), "Martin Luther King Jr. Day"],
    [2, nthWeekdayOfYear(y, 2, 1, 3), "Presidents' Day"],
    [6, 19, "Juneteenth"],
    [7, 4, "Independence Day"],
    [5, lastWeekdayOfMonth(y, 5, 1), "Memorial Day"],
    [9, nthWeekdayOfYear(y, 9, 1, 1), "Labor Day"],
    [10, nthWeekdayOfYear(y, 10, 1, 2), "Columbus Day"],
    [11, 11, "Veterans Day"],
    [11, nthWeekdayOfYear(y, 11, 4, 4), "Thanksgiving"],
    [12, 25, "Christmas"],
  ].map(([mo, da, name]) => ({ m: mo, d: da, name }));
}

function buildHolidaysForYear(y) {
  const out = {};
  const push = (m, d, name, country) => {
    const iso = `${y}-${pad2(m)}-${pad2(d)}`;
    (out[iso] = out[iso] || []).push({ name, country });
  };

  PK_FIXED.forEach(([m, d, name]) => push(m, d, name, "pk"));
  (PK_LUNAR[y] || []).forEach(([m, d, name, extra]) => {
    for (let i = 0; i <= extra; i++) {
      const dt = new Date(y, m - 1, d + i);
      if (dt.getFullYear() === y) push(dt.getMonth() + 1, dt.getDate(), name, "pk");
    }
  });
  usHolidays(y).forEach(({ m, d, name }) => push(m, d, name, "us"));

  return out;
}
