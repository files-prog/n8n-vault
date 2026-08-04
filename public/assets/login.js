'use strict';

const errorBox = document.getElementById('error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

// Error passed back from the Google callback
const params = new URLSearchParams(location.search);
if (params.get('error')) showError(params.get('error'));

// Show the Google button only when the server has it configured.
// A tiny unauthenticated probe endpoint is avoided on purpose: we simply try
// the login page marker set by the server via a HEAD request to /auth/google.
fetch('/auth/google', { method: 'HEAD' }).then((res) => {
  if (res.status !== 404) document.getElementById('google-section').hidden = false;
}).catch(() => {});

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const button = document.getElementById('submit');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
    const next = params.get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  } catch (err) {
    showError(err.message);
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
