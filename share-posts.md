# Sharing posts — U1 Print Hub

Repo / download: https://github.com/dlgambill/u1hub

---

## Reddit (r/Snapmaker)

**Suggested title:**
I got tired of fighting Orca's networking, so I built a free local hub for my U1s — slice once, push to any machine, map colors to heads remotely (beta, looking for testers)

**Body:**

I run a few U1s and love them, but I kept fighting the networking side of Snapmaker Orca every time I went to send a job. In fairness, I'm on T-Mobile home internet, so honestly some of that might be on my WiFi and not Orca — but either way I just wanted something dead simple that lives on my own network and doesn't make me think about it.

So I built **U1 Print Hub**. It's a small app you run on your own PC and open in a browser. Nothing leaves your network.

What it does:

- **See every U1 at once** — the colors loaded in each of the 4 heads, print status, and bed temp, on one screen.
- **Browse your sliced files** and see which colors each job actually needs.
- **Slice once, send to any machine** (or several) right from the browser — no re-slicing per printer.
- **Map each color to a specific toolhead before the print starts — remotely.** This was the tricky part to get right; it sends the machine the same head-mapping commands it uses internally, so you don't have to walk over to the touchscreen for every multicolor job.
- **Set the bed temp from the hub** (handy if, like me, you forget to switch plate profiles).
- **Auto-discovers** your U1s on the network so you're not hunting for IPs.

It's **free and open source (MIT)**. There's a one-click download for Windows/Mac/Linux — no install, no Node, just run it and open the page.

Honest caveats, because it's early:

- It's **beta** and definitely has rough edges.
- It's **LAN-only with no login** — keep it on your home/shop network, don't expose it to the internet.
- It can **start prints**, so please don't wander off mid-print while you're kicking the tires.
- I've confirmed the color-to-head mapping on **4-color** prints. I'd really love help testing **2- and 3-color** jobs — that's the case I haven't fully verified.

Repo, downloads, and a short beta-testing guide are here: https://github.com/dlgambill/u1hub

Not selling anything — there's a "buy me a beer" link if it saves you a headache, but it's completely optional. Mostly I just want feedback and bug reports so I can make it solid. Tear it apart.

---

## Facebook group  (plain text — paste as-is)

Anyone else running more than one U1? 🙂

I've got a few, and I kept fighting the networking side of Snapmaker Orca every time I sent a job. In fairness, I'm on T-Mobile home internet, so some of that might honestly be my WiFi and not Orca 😅 — but either way I wanted something simple that just runs on my own network, so I built one.

It's called U1 Print Hub — a little app you run on your PC and open in a browser:

• See all your U1s at once — what colors are loaded in each head, status, and bed temp
• Browse your sliced files and see which colors each one needs
• Slice once and send the same file to any machine (or several)
• Pick which head prints each color before it starts — remotely, no walking to the touchscreen
• Set the bed temp right from the hub

It's free and open source, with a one-click download for Windows/Mac/Linux (no install needed).

Fair warning: it's beta and it controls real printers, so keep it on your home network and don't wander off mid-print while you're testing it. I've confirmed the color-to-head mapping on 4-color prints and could really use help testing 2- and 3-color ones.

Download + a short beta guide: https://github.com/dlgambill/u1hub

Would love to hear what works and what breaks. 🍺
