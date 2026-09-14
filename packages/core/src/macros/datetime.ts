/**
 * 自写的 moment 子集：宏引擎里 `{{time}} {{date}} {{weekday}} {{isotime}} {{isodate}}
 * {{datetimeformat X}} {{time_UTC±X}} {{idle_duration}} {{timeDiff::a::b}}` 需要的那点能力。
 * 语言环境固定为 en（ST 默认），不引入任何依赖。
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** moment 的 `LT`（`8:05 PM`） */
export const FORMAT_LT = 'h:mm A';
/** moment 的 `LL`（`September 13, 2026`） */
export const FORMAT_LL = 'MMMM D, YYYY';

interface DateParts {
  year: number;
  month: number; // 0–11
  date: number; // 1–31
  weekday: number; // 0–6
  hours: number; // 0–23
  minutes: number;
  seconds: number;
  milliseconds: number;
}

/**
 * 取日期的各字段。`offsetMinutes === null` 用宿主本地时区（ST 在浏览器里的行为），
 * 给了偏移则按 UTC+偏移读取（服务端渲染要确定性，靠 `timezoneOffsetMinutes` 指定）。
 */
function toParts(date: Date, offsetMinutes: number | null): DateParts {
  if (offsetMinutes === null) {
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      date: date.getDate(),
      weekday: date.getDay(),
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
      milliseconds: date.getMilliseconds(),
    };
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    milliseconds: shifted.getUTCMilliseconds(),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** moment 的 `Do`：1st / 2nd / 3rd / 4th … */
function ordinal(value: number): string {
  const rem100 = value % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

// 长 token 必须排在短 token 前面；`[...]` 是 moment 的字面量转义
const TOKEN_PATTERN =
  /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|dd|Do|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x/g;

/** 按 moment 的 format 语法格式化（支持的 token 见 TOKEN_PATTERN） */
export function formatMoment(
  date: Date,
  format: string,
  offsetMinutes: number | null = null,
): string {
  const p = toParts(date, offsetMinutes);
  const hours12 = p.hours % 12 === 0 ? 12 : p.hours % 12;

  return format.replace(TOKEN_PATTERN, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return pad(p.year, 4);
      case 'YY':
        return pad(p.year % 100);
      case 'MMMM':
        return MONTHS[p.month] ?? '';
      case 'MMM':
        return MONTHS_SHORT[p.month] ?? '';
      case 'MM':
        return pad(p.month + 1);
      case 'M':
        return String(p.month + 1);
      case 'dddd':
        return WEEKDAYS[p.weekday] ?? '';
      case 'ddd':
      case 'dd':
        return WEEKDAYS_SHORT[p.weekday] ?? '';
      case 'Do':
        return ordinal(p.date);
      case 'DD':
        return pad(p.date);
      case 'D':
        return String(p.date);
      case 'HH':
        return pad(p.hours);
      case 'H':
        return String(p.hours);
      case 'hh':
        return pad(hours12);
      case 'h':
        return String(hours12);
      case 'mm':
        return pad(p.minutes);
      case 'm':
        return String(p.minutes);
      case 'ss':
        return pad(p.seconds);
      case 's':
        return String(p.seconds);
      case 'SSS':
        return pad(p.milliseconds, 3);
      case 'A':
        return p.hours < 12 ? 'AM' : 'PM';
      case 'a':
        return p.hours < 12 ? 'am' : 'pm';
      case 'X':
        return String(Math.floor(date.getTime() / 1000));
      case 'x':
        return String(date.getTime());
      default:
        return token;
    }
  });
}

const MS_PER_DAY = 86_400_000;
// moment：1 个月 = 146097 / 4800 天 ≈ 30.436875 天
const MS_PER_MONTH = MS_PER_DAY * (146097 / 4800);

/**
 * moment `duration.humanize()` 的 en 子集。
 * 阈值同 moment 默认：ss 44 / s 45 / m 45 / h 22 / d 26 / M 11（周被禁用）。
 */
export function humanizeDuration(ms: number, withSuffix = false): string {
  const abs = Math.abs(ms);
  const seconds = Math.round(abs / 1000);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / MS_PER_DAY);
  const months = Math.round(abs / MS_PER_MONTH);
  const years = Math.round(abs / MS_PER_MONTH / 12);

  let output: string;
  if (seconds <= 44) output = 'a few seconds';
  else if (minutes <= 1) output = 'a minute';
  else if (minutes < 45) output = `${minutes} minutes`;
  else if (hours <= 1) output = 'an hour';
  else if (hours < 22) output = `${hours} hours`;
  else if (days <= 1) output = 'a day';
  else if (days < 26) output = `${days} days`;
  else if (months <= 1) output = 'a month';
  else if (months < 11) output = `${months} months`;
  else if (years <= 1) output = 'a year';
  else output = `${years} years`;

  if (!withSuffix) return output;
  return ms > 0 ? `in ${output}` : `${output} ago`;
}

const TIME_ONLY =
  /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$|^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `{{timeDiff}}` 的宽松时间解析（moment(string) 的常用子集）：
 * ISO / `new Date` 能认的格式，外加纯时间（`8:05 PM`、`20:05`，日期取 `base` 当天）。
 * 认不出来返回 null。
 */
export function parseLooseDate(input: string, base: Date): Date | null {
  const text = input.trim();
  if (!text) return null;

  const timeOnly = TIME_ONLY.exec(text);
  if (timeOnly) {
    const meridiem = timeOnly[4];
    const rawHour = Number(timeOnly[1] ?? timeOnly[5]);
    const minute = Number(timeOnly[2] ?? timeOnly[6]);
    const second = Number(timeOnly[3] ?? timeOnly[7] ?? 0);
    let hour = rawHour;
    if (meridiem) {
      const isPm = meridiem.toLowerCase() === 'p';
      hour = (rawHour % 12) + (isPm ? 12 : 0);
    }
    const result = new Date(base.getTime());
    result.setHours(hour, minute, second, 0);
    return result;
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}
