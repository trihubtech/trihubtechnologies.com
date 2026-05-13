const INDIA_TIME_ZONE = "Asia/Kolkata";
const INDIA_TIME_OFFSET_MINUTES = 5 * 60 + 30;

function getIndiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function indiaDateToUtcDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 0, -INDIA_TIME_OFFSET_MINUTES, 0, 0));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDateOnly(date) {
  const { year, month, day } = getIndiaDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayIndiaDate() {
  const { year, month, day } = getIndiaDateParts();
  return indiaDateToUtcDate(year, month, day);
}

function getIndiaPresetDateRange(preset) {
  const today = todayIndiaDate();
  const { year, month } = getIndiaDateParts();

  const ranges = {
    today: { from: today, to: today },
    yesterday: { from: addDays(today, -1), to: addDays(today, -1) },
    last_week: { from: addDays(today, -6), to: today },
    this_month: { from: indiaDateToUtcDate(year, month, 1), to: today },
    last_month: {
      from: indiaDateToUtcDate(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1, 1),
      to: addDays(indiaDateToUtcDate(year, month, 1), -1),
    },
    last_quarter: { from: addDays(today, -89), to: today },
    last_half_year: { from: addDays(today, -179), to: today },
    last_year: { from: indiaDateToUtcDate(year - 1, 1, 1), to: indiaDateToUtcDate(year - 1, 12, 31) },
    this_year: { from: indiaDateToUtcDate(year, 1, 1), to: today },
  };

  const range = ranges[preset] || ranges.this_month;
  return {
    from: formatDateOnly(range.from),
    to: formatDateOnly(range.to),
  };
}

function getIndiaDurationDateRange(duration, customStart, customEnd) {
  if (duration === "custom" && customStart && customEnd) {
    return { from: customStart, to: customEnd };
  }

  const today = todayIndiaDate();
  const { year, month, day } = getIndiaDateParts();
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const ranges = {
    this_week: { from: addDays(today, -(dayOfWeek === 0 ? 6 : dayOfWeek - 1)), to: today },
    this_month: { from: indiaDateToUtcDate(year, month, 1), to: today },
    last_month: {
      from: indiaDateToUtcDate(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1, 1),
      to: addDays(indiaDateToUtcDate(year, month, 1), -1),
    },
    last_6_months: { from: addDays(today, -179), to: today },
    last_1_year: { from: addDays(today, -364), to: today },
  };

  const range = ranges[duration] || ranges.this_month;
  return {
    from: formatDateOnly(range.from),
    to: formatDateOnly(range.to),
  };
}

module.exports = {
  INDIA_TIME_ZONE,
  formatDateOnly,
  getIndiaDurationDateRange,
  getIndiaPresetDateRange,
  todayIndiaDate,
};
