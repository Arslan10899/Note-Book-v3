// ---------- Public holidays: Pakistan + USA + India ----------
// Fixed dates + rule-based US floating days + Good Friday (Easter-based)
// + year-mapped Islamic (lunar) and Indian festival (lunar) dates.
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

const IN_FIXED = [
  [1, 26, "Republic Day"],
  [4, 14, "Ambedkar Jayanti"],
  [6, 21, "International Yoga Day"],
  [8, 15, "Independence Day"],
  [10, 2, "Gandhi Jayanti"],
  [11, 14, "Children's Day"],
  [12, 25, "Christmas"],
];

// Indian festival (lunar) observances — approximate, verified per year.
// Format: [month, day, name]. Eid dates mirror Pakistan's Islamic calendar.
const IN_LUNAR = {
  2024: [
    [3, 8, "Maha Shivaratri"],
    [3, 25, "Holi"],
    [4, 11, "Eid ul-Fitr"],
    [4, 17, "Ram Navami"],
    [5, 23, "Buddha Purnima"],
    [6, 17, "Eid ul-Adha"],
    [8, 19, "Raksha Bandhan"],
    [8, 26, "Janmashtami"],
    [9, 7, "Ganesh Chaturthi"],
    [9, 16, "Eid Milad un-Nabi"],
    [10, 12, "Dussehra"],
    [10, 31, "Diwali"],
    [11, 15, "Guru Nanak Jayanti"],
  ],
  2025: [
    [2, 26, "Maha Shivaratri"],
    [3, 14, "Holi"],
    [3, 31, "Eid ul-Fitr"],
    [4, 6, "Ram Navami"],
    [5, 12, "Buddha Purnima"],
    [6, 7, "Eid ul-Adha"],
    [8, 9, "Raksha Bandhan"],
    [8, 16, "Janmashtami"],
    [8, 27, "Ganesh Chaturthi"],
    [9, 5, "Eid Milad un-Nabi"],
    [10, 2, "Dussehra"],
    [10, 20, "Diwali"],
    [11, 5, "Guru Nanak Jayanti"],
  ],
  2026: [
    [2, 15, "Maha Shivaratri"],
    [3, 4, "Holi"],
    [3, 20, "Eid ul-Fitr"],
    [3, 26, "Ram Navami"],
    [5, 2, "Buddha Purnima"],
    [5, 27, "Eid ul-Adha"],
    [8, 26, "Eid Milad un-Nabi"],
    [8, 29, "Raksha Bandhan"],
    [9, 4, "Janmashtami"],
    [9, 15, "Ganesh Chaturthi"],
    [10, 20, "Dussehra"],
    [11, 8, "Diwali"],
    [11, 24, "Guru Nanak Jayanti"],
  ],
  2027: [
    [3, 7, "Maha Shivaratri"],
    [3, 10, "Eid ul-Fitr"],
    [3, 22, "Holi"],
    [3, 26, "Ram Navami"],
    [5, 17, "Eid ul-Adha"],
    [5, 21, "Buddha Purnima"],
    [8, 15, "Eid Milad un-Nabi"],
    [8, 17, "Raksha Bandhan"],
    [9, 5, "Ganesh Chaturthi"],
    [9, 16, "Janmashtami"],
    [10, 9, "Dussehra"],
    [10, 29, "Diwali"],
    [11, 14, "Guru Nanak Jayanti"],
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

function goodFridayOf(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31);
  const da = ((h + l - 7 * m + 114) % 31) + 1;
  const friday = new Date(y, mo - 1, da - 2);
  return { m: friday.getMonth() + 1, d: friday.getDate() };
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
  IN_FIXED.forEach(([m, d, name]) => push(m, d, name, "in"));
  const gf = goodFridayOf(y);
  push(gf.m, gf.d, "Good Friday", "in");
  (IN_LUNAR[y] || []).forEach(([m, d, name]) => push(m, d, name, "in"));

  return out;
}
