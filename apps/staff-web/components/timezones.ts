/** Short curated list; India is the launch market (PRD 7.10). Value is an IANA zone. */
export const TIME_ZONES = [
  { value: "Asia/Kolkata", label: "India (IST, UTC+05:30)" },
  { value: "Asia/Dubai", label: "Gulf (GST, UTC+04:00)" },
  { value: "Asia/Singapore", label: "Singapore (UTC+08:00)" },
  { value: "Asia/Kathmandu", label: "Nepal (UTC+05:45)" },
  { value: "Asia/Dhaka", label: "Bangladesh (UTC+06:00)" },
  { value: "Asia/Colombo", label: "Sri Lanka (UTC+05:30)" },
  { value: "Europe/London", label: "United Kingdom" },
  { value: "UTC", label: "UTC" },
] as const;
