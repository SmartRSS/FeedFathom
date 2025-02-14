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
    try {
      if (!event.target) {
        return;
      }

      const instanceAddress = (event.target as HTMLInputElement).value;
      if (instanceAddress) {
        new URL(instanceAddress);
      }

      void browser.storage.sync.set({ instance: instanceAddress });
    } catch {
      alert("bad URL");
    }
  });
})();

export {};
