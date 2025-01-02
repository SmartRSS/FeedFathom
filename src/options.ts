(async () => {
  const storedInstance = await browser.storage.sync.get("instance");
  const instanceInput = document.getElementById(
    "instance",
  ) as HTMLInputElement | null;
  if (!instanceInput) {
    return;
  }
  instanceInput.value = storedInstance["instance"] ?? "";
  instanceInput.addEventListener("change", async function (event: Event) {
    try {
      if (!event.target) {
        return;
      }
      const instanceAddress = (event.target as HTMLInputElement).value;
      if (instanceAddress) {
        new URL(instanceAddress);
      }
      await browser.storage.sync.set({ instance: instanceAddress });
    } catch {
      alert("bad URL");
    }
  });
})();

export {};
