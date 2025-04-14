void (async () => {
  const storedInstance = await chrome.storage.sync.get("instance");
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
      alert("bad URL");
    }

    void chrome.storage.sync.set({ instance: instanceAddress });
  });
})();

export {};
