// Set before first layout; iOS also exposes standalone on navigator.
if (navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches) {
  document.documentElement.classList.add("installed-app");
}
