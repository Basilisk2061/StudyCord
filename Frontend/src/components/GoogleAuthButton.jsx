export default function GoogleAuthButton({ disabled, pending, onClick }) {
  return (
    <button
      type="button"
      className="btn auth-google-button"
      disabled={disabled}
      onClick={onClick}
    >
      <GoogleMark />
      <span>{pending ? 'Connecting to Google...' : 'Continue with Google'}</span>
    </button>
  );
}

function GoogleMark() {
  return (
    <svg
      className="auth-google-mark"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.181l-2.909-2.258c-.806.54-1.835.859-3.047.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.706A5.41 5.41 0 0 1 3.682 9c0-.592.102-1.168.281-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.45.347 2.824.956 4.038l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.58c1.322 0 2.508.455 3.441 1.346l2.582-2.582C13.463.892 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z" />
    </svg>
  );
}
