// Kuenta — muestra el correo de soporte configurado en config.js
(function () {
  var email = (window.KUENTA_CONFIG && window.KUENTA_CONFIG.SUPPORT_EMAIL) || '';
  document.querySelectorAll('[data-support]').forEach(function (el) {
    if (email) { el.textContent = email; el.parentElement.hidden = false; }
  });
})();
