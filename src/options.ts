void (async () => {
  const storedInstance = await browser.storage.sync.get("instance");
  const instanceInput = document.querySelector(
    "#instance",
  ) as HTMLInputElement | null;
  if (!instanceInput) {
    return;
  }

  instanceInput.value =
    typeof storedInstance["instance"] === "string"
      ? storedInstance["instance"]
      : "";
  instanceInput.addEventListener("change", (event: Event) => {
    if (!event.target) {
      return;
    }

    const instanceAddress = (event.target as HTMLInputElement).value;
    if (!URL.canParse(instanceAddress)) {
      // eslint-disable-next-line no-alert
      alert("bad URL");
    }

    void browser.storage.sync.set({ instance: instanceAddress });
  });
})();

export {};
