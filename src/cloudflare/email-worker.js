export default {
  async email(message, env) {
    const domain = env.MAIL_ENDPOINT_DOMAIN;
    const endpoint = `${domain}/api/mail`;

    const cfAccessHeaders = {
      "Content-Type": "application/json",
    };


    const rawText = await new Response(message.raw).text();

    const payload = {
      from: message.from,
      to: message.to,
      subject: message.headers.get("subject"),
      raw: rawText,
    };

    // const token = btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...cfAccessHeaders,
          // "Authorization": `Basic ${token}`
        },
        body: JSON.stringify(payload),
      });
      if(!res.ok){
        console.error(await res.text());
      }
    } catch (err) {
      console.error("Błąd podczas wysyłania do API:", err);
    }
  },
};
