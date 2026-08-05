export function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" fill="#05070a" />
      <path
        d="M16 7 L25 13 V22 L16 28 L7 22 V13 Z"
        stroke="#2c5a56"
        strokeWidth="1.4"
        fill="none"
      />
      <line x1="16" y1="7" x2="16" y2="16" stroke="#4fd1c5" strokeWidth="1.4" />
      <line x1="25" y1="13" x2="16" y2="16" stroke="#4fd1c5" strokeWidth="1.4" />
      <line x1="7" y1="13" x2="16" y2="16" stroke="#2c5a56" strokeWidth="1.4" />
      <line x1="25" y1="22" x2="16" y2="16" stroke="#2c5a56" strokeWidth="1.4" />
      <line x1="7" y1="22" x2="16" y2="16" stroke="#2c5a56" strokeWidth="1.4" />
      <circle cx="16" cy="7" r="2.6" fill="#f5b942" />
      <circle cx="25" cy="13" r="2.2" fill="#4fd1c5" />
      <circle cx="25" cy="22" r="2.2" fill="#1c2530" stroke="#4fd1c5" strokeWidth="1" />
      <circle cx="16" cy="28" r="2.2" fill="#1c2530" stroke="#2c5a56" strokeWidth="1" />
      <circle cx="7" cy="22" r="2.2" fill="#1c2530" stroke="#2c5a56" strokeWidth="1" />
      <circle cx="7" cy="13" r="2.2" fill="#1c2530" stroke="#2c5a56" strokeWidth="1" />
      <circle cx="16" cy="16" r="2" fill="#05070a" stroke="#e8ecf1" strokeWidth="1" />
    </svg>
  );
}
