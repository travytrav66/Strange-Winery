/* ============================================================
   STRANGE FAMILY VINEYARDS — interactions
   ------------------------------------------------------------
   01  Fog canvas (Perlin / fBm)
   01c Daypart sky (hero grades itself to the visitor's local clock)
   01b Brand arc letters (curved wordmark, staggered)
   02  Text splitting (lines + words)
   03  Loader
   04  Scroll engine (nav, parallax — one rAF loop)
   04c Hero film scrub (pinned, scroll-driven video)
   05  Reveal observer
   06  Counters
   07  Marquee
   08  Custom cursor
   09  Drawer
   10  Modals + forms
   ============================================================ */
(function () {
    "use strict";

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var lerp = function (a, b, t) {
        return a + (b - a) * t;
    };
    var clamp = function (v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    };

    /* Shared state between the daypart engine (01c) and the fog canvas (01).
       01c writes the *target* values; 01 eases the live ones toward them every
       frame, so a band crossing drifts in over a few seconds instead of
       popping. Declared out here because 01 runs first and needs the object
       to exist when it does. */
    var SKY = {
        density: 1, // live fog density multiplier
        densityTo: 1, // where it is heading
        tint: [240, 233, 221], // live fog colour, rgb
        tintTo: [240, 233, 221]
    };

    /* ========================================================
       01 · FOG CANVAS
       ======================================================== */
    (function fog() {
        var canvases = Array.prototype.slice.call(document.querySelectorAll(".fog-canvas"));
        if (!canvases.length || reduceMotion) return;

        var perm = (function () {
            var p = [],
                i,
                j,
                t;
            for (i = 0; i < 256; i++) p[i] = i;
            for (i = 255; i > 0; i--) {
                j = Math.floor(Math.random() * (i + 1));
                t = p[i];
                p[i] = p[j];
                p[j] = t;
            }
            var out = [];
            for (i = 0; i < 512; i++) out[i] = p[i & 255];
            return out;
        })();

        function fade(t) {
            return t * t * t * (t * (t * 6 - 15) + 10);
        }
        function lp(a, b, t) {
            return a + t * (b - a);
        }
        function grad(h, x, y) {
            switch (h & 3) {
                case 0:
                    return x + y;
                case 1:
                    return -x + y;
                case 2:
                    return x - y;
                default:
                    return -x - y;
            }
        }
        function noise(x, y) {
            var X = Math.floor(x) & 255,
                Y = Math.floor(y) & 255;
            x -= Math.floor(x);
            y -= Math.floor(y);
            var u = fade(x),
                v = fade(y);
            var a = perm[X] + Y,
                b = perm[X + 1] + Y;
            return lp(lp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u), lp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u), v);
        }
        function fbm(x, y, oct) {
            var val = 0,
                amp = 0.5,
                freq = 1,
                max = 0;
            for (var i = 0; i < oct; i++) {
                val += noise(x * freq, y * freq) * amp;
                max += amp;
                amp *= 0.5;
                freq *= 2.1;
            }
            return val / max;
        }
        function smoothstep(e0, e1, x) {
            var t = clamp((x - e0) / (e1 - e0), 0, 1);
            return t * t * (3 - 2 * t);
        }

        /* Offscreen noise texture. It is upscaled to the full canvas with
           smoothing on, and fog has no fine detail to lose, so this is far
           smaller than the surface it fills — every pixel here costs nine
           noise() evaluations, and the whole pass is the most expensive thing
           on the page by a wide margin. */
        var OW = 200,
            OH = 100;
        var off = document.createElement("canvas");
        off.width = OW;
        off.height = OH;
        var octx = off.getContext("2d");
        var imgData = octx.createImageData(OW, OH);
        var px = imgData.data;

        /* one entry per canvas: its own size, alpha and on-screen state.
           The expensive part (the noise texture) is computed once per frame
           and shared by all of them. */
        var layers = canvases.map(function (c) {
            return {
                c: c,
                ctx: c.getContext("2d"),
                /* the density authored in the markup — the daypart multiplier
                   is applied on top of this at paint time, never baked in */
                base: parseFloat(c.getAttribute("data-fog-alpha") || "1"),
                /* Only the hero's fog answers to the clock. The wines and quote
                   sections hold their authored density and their cream colour
                   at every hour — there the fog is a texture over a photograph,
                   not weather, and it would simply be missing for half the day
                   if it burned off at eleven with the hero's. */
                daypart: !!c.closest(".hero"),
                alpha: 0,
                W: 0,
                H: 0,
                visible: true
            };
        });

        /* The canvas backing store is deliberately half the size of the box it
           fills; CSS stretches it back up. A full-size store meant compositing
           a 1440x900 translucent layer over the page on every scrolled frame,
           which on a machine without much GPU to spare cost more than
           generating the noise did. At half linear size that is a quarter of
           the pixels, and fog is the one thing on the page with no edges to
           soften — you cannot see where the resolution went. */
        var STORE = 0.5;

        function resize() {
            layers.forEach(function (L) {
                L.W = L.c.width = Math.max(1, Math.round(L.c.offsetWidth * STORE));
                L.H = L.c.height = Math.max(1, Math.round(L.c.offsetHeight * STORE));
            });
            /* setting canvas.width wipes it, so do not wait out the redraw
               interval below — repaint on the very next frame */
            acc = REDRAW;
        }

        /* the fog's own colour, used everywhere the clock does not reach */
        var CREAM = [240, 233, 221];
        function alphaOf(L) {
            return clamp(L.base * (L.daypart ? SKY.density : 1), 0, 1);
        }

        var time = 0;
        var idle = false; // true once every visible layer has faded out
        function clearAll() {
            layers.forEach(function (L) {
                if (L.W && L.H) L.ctx.clearRect(0, 0, L.W, L.H);
            });
        }
        if ("IntersectionObserver" in window) {
            layers.forEach(function (L) {
                var host = L.c.parentElement;
                if (!host) return;
                new IntersectionObserver(
                    function (es) {
                        L.visible = es[0].isIntersecting;
                    },
                    { threshold: 0 }
                ).observe(host);
            });
        }

        function renderNoise() {
            for (var y = 0; y < OH; y++) {
                var yf = y / OH;
                var vMask = smoothstep(0, 0.45, yf) * (1 - smoothstep(0.85, 1, yf));
                for (var x = 0; x < OW; x++) {
                    var nx = (x / OW) * 2.8 + time;
                    var ny = (y / OH) * 1.4;
                    var n1 = fbm(nx, ny, 5);
                    var n2 = fbm(nx * 2 + 0.4, ny * 1.8 + time * 0.15, 4);
                    var n = n1 * 0.65 + n2 * 0.35;
                    n = clamp((n + 0.55) * 1.2, 0, 1);
                    var i4 = (y * OW + x) * 4;
                    /* white here, always — the shared texture carries shape
                       only. Each layer is tinted its own colour when it paints,
                       so the hero can take the colour of the hour while the
                       other sections stay cream. */
                    px[i4] = 255;
                    px[i4 + 1] = 255;
                    px[i4 + 2] = 255;
                    px[i4 + 3] = Math.round(n * vMask * 86);
                }
            }
            octx.putImageData(imgData, 0, 0);
        }

        function paint(L) {
            var ctx = L.ctx,
                W = L.W,
                H = L.H;
            if (!W || !H) return;
            ctx.clearRect(0, 0, W, H);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";

            var texAR = OW / OH,
                boxAR = W / H,
                drawW,
                drawH;
            if (boxAR < texAR) {
                drawH = H;
                drawW = H * texAR;
            } else {
                drawW = W;
                drawH = W / texAR;
            }
            var offsetX = (W - drawW) / 2;
            var fogTop = H * 0.18;
            L.alpha = alphaOf(L);
            ctx.globalAlpha = L.alpha;
            ctx.drawImage(off, offsetX, fogTop, drawW, drawH - fogTop);
            ctx.globalAlpha = L.alpha * 0.3;
            ctx.drawImage(off, offsetX, fogTop + H * 0.06, drawW, drawH - fogTop);
            ctx.globalAlpha = 1;

            /* recolour in place. source-in keeps the alpha that was just drawn
               and swaps the pixels underneath it for a flat fill, which is how
               one white texture serves layers of different colours without a
               second noise pass. */
            var t = L.daypart ? SKY.tint : CREAM;
            ctx.globalCompositeOperation = "source-in";
            ctx.fillStyle = "rgb(" + Math.round(t[0]) + "," + Math.round(t[1]) + "," + Math.round(t[2]) + ")";
            ctx.fillRect(0, 0, W, H);
            ctx.globalCompositeOperation = "source-over";
        }

        /* Ease toward whatever 01c last asked for, on a clock rather than a
           frame count. The noise pass is the most expensive thing on the page
           and does not hold 60fps on modest hardware, so a per-frame lerp made
           the fade take five times longer on a slow machine than a fast one —
           and drift out of step with the 2.4s CSS transition on the tint wash.
           TAU 0.7s settles in about two and a half seconds either way. */
        var TAU = 0.7;
        /* How fast the fog crawls, in noise units per second. This used to be
           added per frame (0.0009), which meant the fog physically drifted
           slower on a machine that could not hold 60fps — and the noise pass is
           the heaviest thing on the page, so that was most machines. Against
           the clock instead, everyone sees the same weather. 0.081 is the old
           60fps rate plus half again. */
        var DRIFT = 0.081;

        /* How often the fog is actually redrawn, in seconds. Regenerating the
           noise is ~200k noise() evaluations; doing that 60 times a second was
           making the whole page scroll in steps on anything but a fast machine.

           At DRIFT the field moves 0.081 noise units per second, so between
           redraws it travels about 0.004 units — far below anything the eye can
           resolve in a soft, blurred fog. Redrawing at 20Hz instead of 60 is
           visually identical and costs a third as much. The scroll handlers are
           untouched by this: they run every frame as before, so nothing
           scroll-linked gets any less smooth. */
        var REDRAW = 1 / 20;
        var acc = REDRAW;
        var lastT = 0;

        function loop(t) {
            requestAnimationFrame(loop);
            var dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0.016;
            lastT = t;

            var live = layers.filter(function (L) {
                return L.visible;
            });
            if (!live.length) return;

            var k = 1 - Math.exp(-dt / TAU);
            SKY.density = lerp(SKY.density, SKY.densityTo, k);
            for (var i = 0; i < 3; i++) SKY.tint[i] = lerp(SKY.tint[i], SKY.tintTo[i], k);

            /* Midday and golden ask the hero for no fog at all. Once it has
               faded out there is nothing to draw, so stop drawing it —
               otherwise the per-pixel noise pass would run every frame all
               afternoon for an invisible layer.

               The test has to be per-layer, not on SKY.density alone: the wines
               and quote fog ignores the clock, so density can sit at 0 while
               those layers are still on screen and still need painting. Idle
               only when nothing visible would land above zero. */
            var awake = false;
            for (var L0 = 0; L0 < live.length; L0++) {
                if (alphaOf(live[L0]) >= 0.004) {
                    awake = true;
                    break;
                }
            }
            if (!awake && SKY.densityTo < 0.004) {
                if (!idle) {
                    clearAll();
                    idle = true;
                }
                return;
            }
            idle = false;

            /* the field keeps advancing every frame; only the redraw is rationed */
            time += DRIFT * dt;
            acc += dt;
            if (acc < REDRAW) return;
            acc = 0;

            renderNoise();
            live.forEach(paint);
        }

        window.addEventListener("resize", resize);
        resize();
        requestAnimationFrame(loop);
    })();

    /* ========================================================
       01c · DAYPART SKY
       The hero grades itself to the visitor's local clock.

       All this module does is resolve the current hour to one of six band
       names and write it to <html data-daypart="...">. Everything visible —
       the tint wash over the photo, the grade on the photo itself — is CSS
       hanging off that attribute (styles.css 01b). The one value that can't
       live in CSS is the fog density, so we read --fog-mul back off the
       computed style and hand it to the canvas through SKY. That way the
       bands are defined in exactly one place: the stylesheet.

       Bands, and why:
         night   21:00–05:00  moonlit, cold, the mist sits low
         dawn    05:00–08:00  blue floor, rose on the ridge
         morning 08:00–11:00  heaviest fog — it "lingers past noon"
         midday  11:00–16:00  it lifts. clearest state on the page
         golden  16:00–19:30  the hour the hero photo was actually shot
         dusk    19:30–21:00  amber falling into violet, fog coming back

       DEMO CONTROLS — for showing all six states without waiting a day:
         ?daypart=golden        force one band
         ?daypart=cycle         walk all six, ~5s each, on a loop
         SFV.setDaypart("dusk") same, from the console
         SFV.dayparts           the list, in order
       ======================================================== */
    (function daypart() {
        var root = document.documentElement;

        /* start hour of each band, in local time. Read as: this band runs
           from its own `at` until the next one starts. */
        var BANDS = [
            { id: "night", at: 0 },
            { id: "dawn", at: 5 },
            { id: "morning", at: 8 },
            { id: "midday", at: 11 },
            { id: "golden", at: 16 },
            { id: "dusk", at: 19.5 },
            { id: "night", at: 21 }
        ];

        /* Fog colour per band. Density is not here — it comes from --fog-mul
           in the stylesheet so the two halves of a band can't drift apart.

           These are dimmer than they look like they should be, deliberately.
           The canvas sits above the tint wash, so a bright cream fog would
           undo the grade underneath it — night fog painted at cream values
           reads as glowing smoke, not moonlit mist. Each value is roughly the
           colour the fog would be if it were lit by that hour's sky. */
        var TINT = {
            night: [96, 116, 156],
            dawn: [196, 190, 200],
            morning: [236, 233, 228],
            midday: [248, 244, 236],
            golden: [242, 218, 182],
            dusk: [186, 160, 176]
        };

        var ORDER = ["dawn", "morning", "midday", "golden", "dusk", "night"];
        var current = null;
        var forced = null;

        function bandFor(date) {
            var h = date.getHours() + date.getMinutes() / 60;
            var id = BANDS[0].id;
            for (var i = 0; i < BANDS.length; i++) {
                if (h >= BANDS[i].at) id = BANDS[i].id;
            }
            return id;
        }

        function apply(id, immediate) {
            if (id === current) return;
            current = id;
            root.setAttribute("data-daypart", id);

            var tint = TINT[id] || TINT.midday;
            SKY.tintTo = tint.slice();

            /* --fog-mul is only ever read, never rendered — it rides along in
               the stylesheet purely so the density lives beside the colours
               it belongs with. Read on the next frame so the attribute swap
               has landed in the computed style. */
            requestAnimationFrame(function () {
                var mul = parseFloat(getComputedStyle(root).getPropertyValue("--fog-mul"));
                SKY.densityTo = isNaN(mul) ? 1 : mul;
                /* on the very first pass there is nothing to ease from, so
                   snap — otherwise the page would open at the wrong density
                   and visibly correct itself */
                if (immediate) {
                    SKY.density = SKY.densityTo;
                    SKY.tint = tint.slice();
                }
            });
        }

        /* ---- demo overrides ---- */
        var q = (location.search.match(/[?&]daypart=([\w-]+)/) || [])[1];
        if (q === "cycle") {
            var i = 0;
            apply(ORDER[0], true);
            setInterval(function () {
                i = (i + 1) % ORDER.length;
                apply(ORDER[i]);
            }, 5000);
        } else if (q && TINT[q]) {
            forced = q;
            apply(q, true);
        } else {
            apply(bandFor(new Date()), true);
            /* a page left open on the tasting room's counter all day should
               still be right at 4pm. Cheap enough to check every minute. */
            setInterval(function () {
                if (!forced) apply(bandFor(new Date()));
            }, 60000);
        }

        window.SFV = window.SFV || {};
        window.SFV.dayparts = ORDER;
        window.SFV.setDaypart = function (id) {
            if (!TINT[id]) return false;
            forced = id;
            apply(id);
            return id;
        };
        window.SFV.clearDaypart = function () {
            forced = null;
            apply(bandFor(new Date()));
        };
    })();

    /* ========================================================
       01b · BRAND ARC LETTERS
       Splits the curved wordmark into one tspan per glyph and hands each
       two delays: --in for the load stagger (left to right) and --out for
       the retract when the bar goes compact (last letter first). The CSS
       in section 06 of styles.css picks which one applies.
       ======================================================== */
    (function () {
        var tp = document.getElementById("brand-arc-text");
        if (!tp) return;

        var chars = (tp.textContent || "").trim().split("");
        var n = chars.length;
        if (!n) return;

        tp.textContent = "";
        chars.forEach(function (ch, i) {
            var t = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
            /* a plain space between tspans collapses in SVG text — a
               no-break space keeps the word gap */
            t.textContent = ch === " " ? " " : ch;
            /* the load stagger waits out the loader's own exit */
            t.style.setProperty("--in", i * 42 + 260 + "ms");
            t.style.setProperty("--out", (n - 1 - i) * 16 + "ms");
            tp.appendChild(t);
        });
    })();

    /* ========================================================
       02 · TEXT SPLITTING
       Wraps each line (data-split="line") or word (="word") in
       a masked box so it can rise into view.
       ======================================================== */
    function splitWords(el, perChar) {
        var walk = function (node) {
            var kids = Array.prototype.slice.call(node.childNodes);
            kids.forEach(function (child) {
                if (child.nodeType === 3) {
                    var text = child.nodeValue;
                    if (!text.trim()) return;
                    var frag = document.createDocumentFragment();
                    text.split(/(\s+)/).forEach(function (chunk) {
                        if (!chunk) return;
                        if (/^\s+$/.test(chunk)) {
                            frag.appendChild(document.createTextNode(" "));
                            return;
                        }
                        var w = document.createElement("span");
                        w.className = "split-word";
                        if (perChar) {
                            /* the word stays one inline-block so it can never
                               break mid-word; the letters inside it animate
                               individually */
                            chunk.split("").forEach(function (ch) {
                                var g = document.createElement("i");
                                g.textContent = ch;
                                w.appendChild(g);
                            });
                        } else {
                            var inner = document.createElement("i");
                            inner.textContent = chunk;
                            w.appendChild(inner);
                        }
                        frag.appendChild(w);
                    });
                    node.replaceChild(frag, child);
                } else if (child.nodeType === 1 && !child.classList.contains("split-word")) {
                    walk(child);
                }
            });
        };
        walk(el);
        // stagger
        var i = 0;
        var step = perChar ? 0.024 : 0.055;
        el.querySelectorAll(".split-word > i").forEach(function (n) {
            n.style.transitionDelay = (i * step).toFixed(3) + "s";
            i++;
        });
    }

    /* Splits on <br> boundaries into masked line blocks. */
    function splitLines(el) {
        var html = el.innerHTML;
        var parts = html.split(/<br\s*\/?>/i);
        el.innerHTML = parts
            .map(function (p) {
                return '<span class="split-line"><span>' + p + "</span></span>";
            })
            .join("");
    }

    if (!reduceMotion) {
        document.querySelectorAll('[data-split="word"]').forEach(function (el) {
            splitWords(el, false);
        });
        document.querySelectorAll('[data-split="char"]').forEach(function (el) {
            splitWords(el, true);
        });
        document.querySelectorAll('[data-split="line"]').forEach(splitLines);
    }

    /* ========================================================
       02b · BUTTONS — duplicate the label inside the fill layer
       so letters invert as the sweep passes over them
       ======================================================== */
    function dressButtons(root) {
        (root || document).querySelectorAll(".ghost-btn, .btn-solid").forEach(function (btn) {
            if (btn.getAttribute("data-dressed")) return;
            btn.setAttribute("data-dressed", "1");

            var label = document.createElement("span");
            label.className = "btn-t";
            while (btn.firstChild) label.appendChild(btn.firstChild);
            btn.appendChild(label);

            var fill = document.createElement("span");
            fill.className = "btn-fill";
            fill.setAttribute("aria-hidden", "true");
            fill.appendChild(label.cloneNode(true));
            btn.appendChild(fill);
        });
    }
    dressButtons();

    /* ========================================================
       03 · LOADER
       ======================================================== */
    (function () {
        var loader = document.getElementById("loader");
        var barFill = document.getElementById("loader-bar-fill");
        var pctEl = document.getElementById("loader-pct");
        if (!loader) {
            document.body.classList.add("loaded");
            return;
        }

        var current = 0,
            target = 0,
            done = false;

        function setTarget(n) {
            target = Math.min(100, Math.max(target, Math.round(n)));
        }

        function tick() {
            if (current < target) {
                current = Math.min(target, current + Math.max(1, Math.round((target - current) * 0.13)));
                barFill.style.width = current + "%";
                if (pctEl) pctEl.textContent = current;
            }
            if (current < 100) {
                requestAnimationFrame(tick);
            } else if (!done) {
                done = true;
                barFill.style.width = "100%";
                if (pctEl) pctEl.textContent = "100";
                setTimeout(function () {
                    loader.classList.add("hidden");
                    document.body.classList.add("loaded");
                }, 380);
            }
        }
        requestAnimationFrame(tick);

        var imgs = Array.prototype.slice.call(document.images);
        var total = imgs.length || 1;
        var loaded = 0;
        function onImgLoad() {
            loaded++;
            setTarget((loaded / total) * 92);
        }
        imgs.forEach(function (img) {
            if (img.complete) onImgLoad();
            else {
                img.addEventListener("load", onImgLoad);
                img.addEventListener("error", onImgLoad);
            }
        });

        function full() {
            setTarget(100);
        }
        if (document.readyState === "complete") full();
        else window.addEventListener("load", full);
        /* hard ceiling — never trap the visitor behind a stalled asset */
        setTimeout(full, 5000);
    })();

    /* ========================================================
       04 · SCROLL ENGINE — one rAF loop for everything
       ======================================================== */
    (function () {
        var nav = document.querySelector(".nav");
        var parallaxEls = Array.prototype.slice.call(document.querySelectorAll("[data-parallax]"));
        var storyPhotoImg = document.querySelector(".story-photo img");
        var storyInset = document.querySelector(".story-photo-inset");
        var vinePhotoImg = document.querySelector(".vine-photo img");
        var hero = document.querySelector(".hero");
        var wines = document.getElementById("wines");
        var wineSeal = wines && wines.querySelector(".seal");

        /* process section: sticky image follows whichever step is centred */
        var pSection = document.querySelector(".process");
        var pSteps = Array.prototype.slice.call(document.querySelectorAll(".process-steps .step"));
        var pImgs = Array.prototype.slice.call(document.querySelectorAll(".pm-img"));
        var pNo = document.querySelector(".pm-no");
        var pTxt = document.querySelector(".pm-txt");
        var pFill = document.querySelector(".pm-fill");
        var pActive = 0;

        /* visit section: corner brackets open and close with scroll */
        var visit = document.querySelector(".visit");
        var lastVp = -1;

        /* quote section: pinned stage, grayscale -> colour across the track */
        var quote = document.querySelector(".quote");
        var quoteTrack = quote ? quote.querySelector(".quote-track") : null;
        var lastQp = -1;

        function updateQuote(vh) {
            if (!quote || !quoteTrack) return;
            var qp;
            if (reduceMotion) {
                qp = 1;
            } else {
                var r = quoteTrack.getBoundingClientRect();
                /* how far the stage has been held in place, 0 -> 1 */
                var span = Math.max(1, r.height - vh);
                var raw = clamp(-r.top / span, 0, 1);
                /* hold a beat of pure grayscale on arrival and a beat of full
                   colour before the release; linear in between, because the
                   crossfade already reads as eased to the eye */
                qp = clamp((raw - 0.07) / 0.79, 0, 1);
            }
            if (Math.abs(qp - lastQp) < 0.002) return;
            lastQp = qp;
            quote.style.setProperty("--qp", qp.toFixed(4));
        }

        /* visit section: the corner brackets open as the section comes to the
           middle of the screen and close again as it leaves, so the frame is at
           its widest exactly while you are looking at the picture.

           --vp peaks at 1 with the section centred and falls off either side.
           The 1.5 multiplier makes it reach 0 before the section is fully gone,
           so the arms are settled at their short length rather than still
           moving when the section is barely on screen.

           The brackets change width/height rather than being scaled: a
           transform would take the 1px borders with it and the hairline would
           stop being a hairline. They are absolutely positioned and
           pointer-events: none, so resizing them reflows nothing else. */
        function updateVisit(vh) {
            if (!visit) return;
            var vp = 1;
            if (!reduceMotion) {
                var r = visit.getBoundingClientRect();
                var off = (r.top + r.height / 2 - vh / 2) / vh; // 0 when centred
                vp = clamp(1 - Math.abs(off) * 1.5, 0, 1);
            }
            if (Math.abs(vp - lastVp) < 0.002) return;
            lastVp = vp;
            visit.style.setProperty("--vp", vp.toFixed(4));
        }

        function updateProcess(vh) {
            if (!pSection || !pSteps.length || !pImgs.length) return;
            var sr = pSection.getBoundingClientRect();
            if (sr.bottom < 0 || sr.top > vh) return;
            var mid = vh * 0.5;
            var best = 0,
                bestD = Infinity;
            for (var i = 0; i < pSteps.length; i++) {
                var r = pSteps[i].getBoundingClientRect();
                var d = Math.abs(r.top + r.height / 2 - mid);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            }
            if (best === pActive) return;
            pActive = best;
            for (var j = 0; j < pImgs.length; j++) {
                pImgs[j].classList.toggle("is-active", j === best);
            }
            if (pNo) pNo.textContent = ("0" + (best + 1)).slice(-2);
            if (pTxt) {
                var season = pSteps[best].querySelector(".season");
                if (season) pTxt.textContent = season.textContent;
            }
            if (pFill) pFill.style.transform = "scaleX(" + ((best + 1) / pSteps.length).toFixed(3) + ")";
        }

        var lastY = window.scrollY || 0;
        var ticking = false;

        function frame() {
            ticking = false;
            var y = window.scrollY || window.pageYOffset;
            var vh = window.innerHeight;

            /* --- nav state --- */
            if (nav) {
                nav.classList.toggle("scrolled", y > 60);
                /* hide on scroll-down past the hero, reveal on scroll-up */
                if (y > vh * 0.9 && y > lastY + 4) nav.classList.add("nav-hidden");
                else if (y < lastY - 4 || y < vh * 0.6) nav.classList.remove("nav-hidden");
            }

            updateProcess(vh);
            updateQuote(vh);
            updateVisit(vh);

            /* --- hero exit: 0 -> 1 across the first viewport. When the
                   pinned film hero is running (04c) it owns --exit instead,
                   because the copy has to hold while the film plays. --- */
            if (hero && !hero.classList.contains("is-scrub")) {
                var exit = reduceMotion ? 0 : clamp(y / (vh * 0.92), 0, 1);
                hero.style.setProperty("--exit", exit.toFixed(4));
            }

            if (!reduceMotion) {
                /* --- generic parallax layers --- */
                parallaxEls.forEach(function (el) {
                    var host = el.parentElement;
                    var r = host.getBoundingClientRect();
                    if (r.bottom < -200 || r.top > vh + 200) return;
                    var speed = parseFloat(el.getAttribute("data-parallax")) || 0.15;
                    var offset = (r.top + r.height / 2 - vh / 2) * -speed;
                    el.style.transform = "translate3d(0," + offset.toFixed(1) + "px,0)";
                });

                /* --- story two-photo depth (desktop) --- */
                if (storyPhotoImg && window.innerWidth >= 981) {
                    var wrap = storyPhotoImg.closest(".story-photo-wrap");
                    if (wrap) {
                        var wr = wrap.getBoundingClientRect();
                        if (wr.bottom > -300 && wr.top < vh + 300) {
                            var c = wr.top + wr.height / 2 - vh / 2;
                            storyPhotoImg.style.transform = "translate3d(0," + (c * -0.055).toFixed(1) + "px,0)";
                            if (storyInset) storyInset.style.transform = "translate3d(0," + (c * -0.018).toFixed(1) + "px,0)";
                        }
                    }
                }

                /* --- wax seal depth (768px+ only, where it's pressed onto the
                       section's top-right corner rather than centred on the seam).
                       Measured off the wines section's top edge, not the seal's
                       own rect — the seal's transform is what's being written
                       here, so reading it back would feed into itself. The
                       offset rides a CSS var so the base translate/rotate that
                       places it on the boundary stays in the stylesheet. --- */
                if (wineSeal && window.innerWidth >= 768) {
                    var sr2 = wines.getBoundingClientRect();
                    if (sr2.bottom > -400 && sr2.top < vh + 400) {
                        /* zero when the boundary sits at the middle of the
                           viewport, so the 65%/35% split across the edge is
                           exact at the point you actually look at it. Clamped
                           because the section stays on screen well past where
                           the raw offset would keep growing. */
                        var sc = sr2.top - vh / 2;
                        wineSeal.style.setProperty("--seal-shift", clamp(sc * -0.08, -60, 60).toFixed(1) + "px");
                    }
                }

                /* --- vineyard photo depth (desktop), same feel as the story --- */
                if (vinePhotoImg && window.innerWidth >= 981) {
                    var vbox = vinePhotoImg.parentElement;
                    if (vbox) {
                        var vr = vbox.getBoundingClientRect();
                        if (vr.bottom > -300 && vr.top < vh + 300) {
                            var vc = vr.top + vr.height / 2 - vh / 2;
                            vinePhotoImg.style.transform = "translate3d(0," + (vc * -0.055).toFixed(1) + "px,0)";
                        }
                    }
                }

            }

            lastY = y;
        }

        function onScroll() {
            if (!ticking) {
                ticking = true;
                requestAnimationFrame(frame);
            }
        }
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        onScroll();
    })();

    /* ========================================================
       04c · HERO FILM SCRUB  —  OFF (still photo hero)
       The hero stage pins for one extra screen and hero-vid.mp4 is
       scrubbed across it by scroll position — static until the visitor
       moves, then a frame per pixel. Its own rAF (rather than the scroll
       loop) so the seek can ease toward the target instead of stepping.

       TO BRING THE FILM BACK: set data-hero-mode="video" on the .hero
       section in index.html. That single attribute drives all three
       pieces — this scrub engine, the two-screen track height in
       styles.css, and whether the <video> is shown at all. Nothing here
       needs editing.

       While the mode is "image" this bails before assigning vid.src, so
       the mp4 is never requested, and .is-scrub is never added — which
       hands --exit back to the main scroll loop (03), where the hero copy
       drifts out over the first viewport as it did before the film.
       ======================================================== */
    (function () {
        var hero = document.querySelector(".hero");
        var track = hero && hero.querySelector(".hero-track");
        var stage = hero && hero.querySelector(".hero-stage");
        var vid = document.getElementById("hero-vid");
        if (!hero || !track || !stage || !vid) return;

        if (hero.getAttribute("data-hero-mode") !== "video") return;

        /* the markup ships no src — assigning it here is what triggers the
           download, so a phone or a reduced-motion visit never pays for it
           and keeps the still photo instead */
        if (reduceMotion || !window.matchMedia("(min-width: 981px)").matches) return;

        hero.classList.add("is-scrub");
        vid.src = vid.getAttribute("data-src");
        vid.load();

        var dur = 0;
        var cur = 0;
        var raf = null;
        var visible = true;

        vid.addEventListener("loadedmetadata", function () {
            dur = vid.duration || 0;
        });
        vid.addEventListener(
            "loadeddata",
            function () {
                vid.classList.add("is-ready");
            },
            { once: true }
        );

        function frame() {
            raf = visible ? requestAnimationFrame(frame) : null;

            var r = track.getBoundingClientRect();
            var vh = window.innerHeight;
            /* how far the stage has been held in place, 0 -> 1 */
            var span = Math.max(1, r.height - vh);
            var p = clamp(-r.top / span, 0, 1);

            /* --exit is driven by the stage's own travel, not by p: it reads 0
               for the whole pin (top stays at 0) and only ramps once the stage
               is released and starts scrolling away — so the copy holds while
               the film plays instead of fading out underneath it */
            hero.style.setProperty("--exit", clamp(-stage.getBoundingClientRect().top / (vh * 0.92), 0, 1).toFixed(4));

            if (!dur) return;
            /* the film lands on its last frame at 88% of the pin, leaving a
               beat of held image before the release */
            var target = clamp(p / 0.88, 0, 1) * (dur - 0.06);
            cur = lerp(cur, target, 0.2);
            /* never stack a seek on an in-flight one, and don't pay for a
               correction smaller than a third of a frame */
            if (!vid.seeking && Math.abs(cur - vid.currentTime) > 0.012) vid.currentTime = cur;
        }

        if ("IntersectionObserver" in window) {
            new IntersectionObserver(
                function (es) {
                    visible = es[0].isIntersecting;
                    if (visible && !raf) raf = requestAnimationFrame(frame);
                },
                { threshold: 0 }
            ).observe(track);
        }
        raf = requestAnimationFrame(frame);
    })();

    /* ========================================================
       04b · LIVE TASTING ROOM STATUS
       Sun/Mon 12–5:30 · Tue–Thu 12–6 · Fri/Sat 11–7

       Four states, driven off the real clock:
         open      "Open now · until 6 PM"        sage dot, slow pulse
         soon      "Closing soon · 6 PM"          gold dot   (last hour)
         closed    "Closed · opens at noon"       dim dot    (opens later today)
         closed    "Closed · opens tomorrow at noon"         (opens another day)

       TIME ZONE — this is the one thing to get right here. The daypart engine
       (01c) deliberately uses the *visitor's* clock, because it is about the
       light where they are sitting. This is the opposite: it is a fact about
       a building in Los Olivos, so it is computed in America/Los_Angeles no
       matter where the visitor is. Someone opening the page in New York at
       8pm should be told the tasting room is open, because at 5pm Pacific it
       is. Falls back to the visitor's own clock only if the browser refuses
       the time zone, which no current browser does.

       Writes to two places: the hero card, and the footer hours list, where
       today's row is marked and given a live line of its own.

       DEMO CONTROLS — for showing the client all four states in a meeting:
         ?now=17:45          pretend it is 5:45pm today (winery wall clock)
         ?now=sun+13:00      pretend it is 1pm on a Sunday
         SFV.setNow("19:30") same, from the console
         SFV.clearNow()      back to the real clock
       ======================================================== */
    (function status() {
        var TZ = "America/Los_Angeles";

        /* one row per day, Sunday first. Decimal hours: 17.5 is 5:30pm.
           `close` is when the door shuts — the last pour is earlier, but that
           is the winery's business, not ours. */
        var HOURS = [
            { open: 12, close: 17.5 }, // Sun
            { open: 12, close: 17.5 }, // Mon
            { open: 12, close: 18 }, // Tue
            { open: 12, close: 18 }, // Wed
            { open: 12, close: 18 }, // Thu
            { open: 11, close: 19 }, // Fri
            { open: 11, close: 19 } // Sat
        ];
        var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        var SOON = 1; // hours before close that counts as "closing soon"

        var card = document.getElementById("hc-status");
        var hoursList = document.querySelector(".hours-list");
        if (!card && !hoursList) return;

        var override = null; // {day, hour} or null

        /* The winery's wall clock, whatever the visitor's is. Formatting the
           date into the tasting room's zone and parsing it back gives a Date
           whose fields read as Los Olivos local time. */
        function wineryNow() {
            var d = new Date();
            try {
                d = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
                if (isNaN(d)) d = new Date();
            } catch (e) {
                d = new Date();
            }
            if (override) {
                if (override.day != null) d.setDate(d.getDate() + ((override.day - d.getDay() + 7) % 7));
                d.setHours(Math.floor(override.hour), Math.round((override.hour % 1) * 60), 0, 0);
            }
            return d;
        }

        /* 12 -> "noon", 17.5 -> "5:30 PM", 19 -> "7 PM" */
        function clock(h) {
            if (h === 12) return "noon";
            var hr = Math.floor(h);
            var mn = Math.round((h % 1) * 60);
            var mer = hr >= 12 ? "PM" : "AM";
            var h12 = hr % 12 || 12;
            return h12 + (mn ? ":" + (mn < 10 ? "0" : "") + mn : "") + " " + mer;
        }

        function resolve() {
            var now = wineryNow();
            var day = now.getDay();
            var h = now.getHours() + now.getMinutes() / 60;
            var today = HOURS[day];

            if (h >= today.open && h < today.close) {
                var left = today.close - h;
                return left <= SOON ? { state: "soon", label: "Closing soon", detail: clock(today.close), day: day } : { state: "open", label: "Open now", detail: "until " + clock(today.close), day: day };
            }

            /* shut — find the next door that opens. Today still counts if we
               are here before opening. */
            if (h < today.open) return { state: "closed", label: "Closed", detail: "opens at " + clock(today.open), day: day };
            for (var i = 1; i <= 7; i++) {
                var d = (day + i) % 7;
                if (HOURS[d]) {
                    var when = i === 1 ? "tomorrow" : DAYS[d];
                    return { state: "closed", label: "Closed", detail: "opens " + when + " at " + clock(HOURS[d].open), day: day };
                }
            }
            return { state: "closed", label: "Closed", detail: "", day: day };
        }

        var last = "";
        function render() {
            var s = resolve();
            var key = s.state + s.label + s.detail;
            if (key === last) return;
            last = key;

            if (card) {
                card.setAttribute("data-state", s.state);
                /* two lines, not one run-on: the state in the display serif,
                   the qualifier under it in the UI face. "Closed · opens
                   tomorrow at noon" is too long to sit on one line in a card
                   this narrow, and wrapping a serif mid-phrase looks broken. */
                card.innerHTML = '<span class="hc-line"><i class="hc-dot" aria-hidden="true"></i><span class="hc-now">' + s.label + '</span></span>' + (s.detail ? '<span class="hc-detail">' + s.detail + "</span>" : "");
                /* the visible text already says it; this keeps a screen reader
                   from reading the separator as punctuation soup */
                card.setAttribute("aria-label", s.label + ", " + s.detail);
            }

            if (hoursList) {
                hoursList.querySelectorAll("li").forEach(function (li) {
                    var days = (li.getAttribute("data-days") || "").split(",");
                    var on = days.indexOf(String(s.day)) > -1;
                    li.classList.toggle("is-today", on);
                    li.setAttribute("data-state", on ? s.state : "");
                });
            }
        }

        render();
        /* a page left open behind the bar all afternoon should still flip at
           six. One cheap check a minute. */
        setInterval(render, 60000);

        window.SFV = window.SFV || {};
        window.SFV.setNow = function (str) {
            /* accepts "17:45", "sun 13:00", "sun+13:00" */
            var m = String(str)
                .toLowerCase()
                .match(/^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*[\s+]*)?(\d{1,2})(?::(\d{2}))?$/);
            if (!m) return false;
            override = {
                day: m[1] ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[1]) : null,
                hour: parseInt(m[2], 10) + (m[3] ? parseInt(m[3], 10) / 60 : 0)
            };
            last = "";
            render();
            return true;
        };
        window.SFV.clearNow = function () {
            override = null;
            last = "";
            render();
        };

        var q = (location.search.match(/[?&]now=([^&]+)/) || [])[1];
        if (q) window.SFV.setNow(decodeURIComponent(q).replace(/\+/g, " "));
    })();

    /* ========================================================
       05 · REVEAL OBSERVER
       ======================================================== */
    (function () {
        /* The hero is driven by `body.loaded`, not by scroll. It also carries
           [data-split], so the observer was tagging it `.in` the instant the
           page painted — which satisfied `.in .split-word > i` and skipped the
           entrance entirely. Keep the observer out of the hero. */
        var targets = Array.prototype.slice
            .call(document.querySelectorAll(".reveal, .mask-img, .step, .rule, [data-split]"))
            .filter(function (el) {
                return !el.closest(".hero");
            });
        if (!("IntersectionObserver" in window)) {
            targets.forEach(function (el) {
                el.classList.add("in");
            });
            return;
        }
        if (!targets.length) return;
        var io = new IntersectionObserver(
            function (entries) {
                entries.forEach(function (e) {
                    if (!e.isIntersecting) return;
                    e.target.classList.add("in");
                    io.unobserve(e.target);
                });
            },
            { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
        );
        targets.forEach(function (el) {
            io.observe(el);
        });
    })();

    /* ========================================================
       06 · COUNTERS
       ======================================================== */
    (function () {
        var nums = document.querySelectorAll("[data-count-to]");
        if (!nums.length) return;
        function run(el) {
            var to = parseFloat(el.getAttribute("data-count-to"));
            var dec = parseInt(el.getAttribute("data-decimals") || "0", 10);
            var suf = el.getAttribute("data-suffix") || "";
            var dur = 1600;
            var t0 = null;
            function step(ts) {
                if (t0 === null) t0 = ts;
                var p = clamp((ts - t0) / dur, 0, 1);
                var eased = 1 - Math.pow(1 - p, 4);
                el.innerHTML = (to * eased).toFixed(dec) + (suf ? '<span class="suf">' + suf + "</span>" : "");
                if (p < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
        }
        if (!("IntersectionObserver" in window) || reduceMotion) {
            nums.forEach(function (el) {
                var suf = el.getAttribute("data-suffix") || "";
                el.innerHTML = el.getAttribute("data-count-to") + (suf ? '<span class="suf">' + suf + "</span>" : "");
            });
            return;
        }
        var io = new IntersectionObserver(
            function (es) {
                es.forEach(function (e) {
                    if (!e.isIntersecting) return;
                    run(e.target);
                    io.unobserve(e.target);
                });
            },
            { threshold: 0.5 }
        );
        nums.forEach(function (el) {
            io.observe(el);
        });
    })();

    /* ========================================================
       06b · PHOTO HAIRLINE
       Built at the box's real pixel size rather than in a stretched
       viewBox: with preserveAspectRatio="none" the dash length and the
       path length are measured in different spaces, so the stroke stops
       part way round instead of closing the shape.
       ======================================================== */
    (function () {
        var rules = Array.prototype.slice.call(document.querySelectorAll(".photo-rule"));
        if (!rules.length) return;

        var INSET = 18;
        var CUT = 0.12; /* matches the clip-path on .story-photo / .vine-photo */

        function build(svg) {
            var box = svg.parentElement;
            var w = box.clientWidth;
            var h = box.clientHeight;
            if (!w || !h) return;
            var path = svg.querySelector("path");
            if (!path) return;

            /* the crop's chamfer runs from (0, CUT*h) to (CUT*w, 0). Offset it
               along its own normal so the hairline stays parallel to the cut
               rather than pinching at the corner. */
            var cx = CUT * w;
            var cy = CUT * h;
            var len = Math.sqrt(cx * cx + cy * cy) || 1;
            var nx = (cy / len) * INSET;
            var ny = (cx / len) * INSET;
            /* where that offset line meets the inset left and top edges */
            var y1 = cy + ny - (cy * (INSET - nx)) / cx;
            var x2 = nx + (cx * (cy + ny - INSET)) / cy;

            svg.setAttribute("viewBox", "0 0 " + w + " " + h);
            path.setAttribute(
                "d",
                "M" + INSET + " " + y1.toFixed(1) +
                    "L" + x2.toFixed(1) + " " + INSET +
                    "L" + (w - INSET) + " " + INSET +
                    "L" + (w - INSET) + " " + (h - INSET) +
                    "L" + INSET + " " + (h - INSET) +
                    "Z"
            );
            /* hand the measured perimeter to the stylesheet, which owns the
               draw-in transition */
            path.style.setProperty("--rule-len", path.getTotalLength().toFixed(1) + "px");
        }

        function buildAll() {
            rules.forEach(build);
        }
        buildAll();

        if (window.ResizeObserver) {
            var ro = new ResizeObserver(buildAll);
            rules.forEach(function (svg) {
                if (svg.parentElement) ro.observe(svg.parentElement);
            });
        } else {
            var t;
            window.addEventListener("resize", function () {
                clearTimeout(t);
                t = setTimeout(buildAll, 150);
            });
        }
    })();

    /* ========================================================
       07 · ACCOLADES MARQUEE
       ======================================================== */
    (function () {
        var track = document.getElementById("marquee");
        if (!track) return;
        var row = track.querySelector(".marquee-row");
        if (!row) return;

        /* duplicate until we comfortably exceed 2x viewport, so the loop is seamless */
        var clones = 0;
        while (track.scrollWidth < window.innerWidth * 2.2 && clones < 8) {
            track.appendChild(row.cloneNode(true));
            clones++;
        }
        if (reduceMotion) return;

        var x = 0;
        var speed = 0.32; /* px per frame at 60fps */
        var unit = row.getBoundingClientRect().width;
        var paused = false;

        track.addEventListener("mouseenter", function () {
            paused = true;
        });
        track.addEventListener("mouseleave", function () {
            paused = false;
        });

        function tick() {
            requestAnimationFrame(tick);
            if (paused || !unit) return;
            x -= speed;
            if (-x >= unit) x += unit;
            track.style.transform = "translate3d(" + x.toFixed(2) + "px,0,0)";
        }
        window.addEventListener("resize", function () {
            unit = row.getBoundingClientRect().width;
        });
        requestAnimationFrame(tick);
    })();

    /* ========================================================
       07b · VISIT SLIDER
       ======================================================== */
    (function () {
        var wrap = document.getElementById("visit-slides");
        if (!wrap) return;
        var slides = Array.prototype.slice.call(wrap.querySelectorAll(".slide"));
        if (slides.length < 2) return;

        var prev = document.getElementById("visit-prev");
        var next = document.getElementById("visit-next");
        var idxEl = document.getElementById("visit-index");
        var totEl = document.getElementById("visit-total");
        var bar = document.getElementById("visit-bar");
        var section = document.querySelector(".visit");

        var i = 0;
        var timer = null;
        /* the wipe runs ~2s — the still needs longer than that to be a still */
        var DWELL = 7400;

        function pad(n) {
            return (n < 10 ? "0" : "") + n;
        }

        /* dir mirrors the whole transition: >= 0 wipes in from the right,
           < 0 from the left. Passing 0 (the first paint) skips the leaving
           state so nothing animates on load. */
        function show(n, dir) {
            var from = i;
            i = (n + slides.length) % slides.length;
            wrap.classList.toggle("dir-prev", dir < 0);
            wrap.classList.toggle("dir-next", !(dir < 0));
            slides.forEach(function (s, k) {
                s.classList.toggle("is-active", k === i);
                s.classList.toggle("is-leaving", !!dir && k === from && from !== i);
            });
            if (idxEl) idxEl.textContent = pad(i + 1);
            if (bar) {
                bar.style.width = (100 / slides.length).toFixed(3) + "%";
                bar.style.transform = "translateX(" + i * 100 + "%)";
            }
        }

        function go(dir) {
            show(i + dir, dir);
            restart();
        }
        function restart() {
            clearInterval(timer);
            if (!reduceMotion) timer = setInterval(function () {
                show(i + 1, 1);
            }, DWELL);
        }

        if (totEl) totEl.textContent = pad(slides.length);
        show(0, 0);
        restart();

        if (prev)
            prev.addEventListener("click", function () {
                go(-1);
            });
        if (next)
            next.addEventListener("click", function () {
                go(1);
            });

        /* pause while the visitor is reading, resume when they leave */
        if (section) {
            section.addEventListener("mouseenter", function () {
                clearInterval(timer);
            });
            section.addEventListener("mouseleave", restart);
        }

        /* only run the carousel while it is actually on screen */
        if ("IntersectionObserver" in window && section) {
            new IntersectionObserver(
                function (es) {
                    if (es[0].isIntersecting) restart();
                    else clearInterval(timer);
                },
                { threshold: 0 }
            ).observe(section);
        }

        /* keyboard + swipe */
        document.addEventListener("keydown", function (e) {
            if (!section) return;
            var r = section.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) return;
            if (e.key === "ArrowLeft") go(-1);
            if (e.key === "ArrowRight") go(1);
        });

        var startX = null;
        wrap.addEventListener(
            "touchstart",
            function (e) {
                startX = e.touches[0].clientX;
            },
            { passive: true }
        );
        wrap.addEventListener(
            "touchend",
            function (e) {
                if (startX === null) return;
                var dx = e.changedTouches[0].clientX - startX;
                if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
                startX = null;
            },
            { passive: true }
        );
    })();

    /* ========================================================
       08 · CUSTOM CURSOR
       ======================================================== */
    (function () {
        var fine = window.matchMedia("(pointer: fine)").matches;
        if (!fine || reduceMotion) return;

        /* ---- cursor ---- */
        var ring = document.getElementById("cursor");
        var dot = document.getElementById("cursor-dot");
        if (!ring || !dot) return;

        var mx = window.innerWidth / 2,
            my = window.innerHeight / 2;
        var rx = mx,
            ry = my;

        window.addEventListener(
            "mousemove",
            function (e) {
                mx = e.clientX;
                my = e.clientY;
                document.body.classList.add("cursor-ready");
                dot.style.transform = "translate3d(" + mx + "px," + my + "px,0)";
            },
            { passive: true }
        );
        document.addEventListener("mouseleave", function () {
            document.body.classList.remove("cursor-ready");
        });

        (function ringLoop() {
            requestAnimationFrame(ringLoop);
            rx = lerp(rx, mx, 0.16);
            ry = lerp(ry, my, 0.16);
            ring.style.transform = "translate3d(" + rx.toFixed(2) + "px," + ry.toFixed(2) + "px,0)";
        })();

        var hoverSel = "a, button, .wine-card, .tier, [data-open], input, select";
        document.addEventListener(
            "mouseover",
            function (e) {
                if (e.target.closest && e.target.closest(hoverSel)) ring.classList.add("is-hover");
            },
            true
        );
        document.addEventListener(
            "mouseout",
            function (e) {
                if (e.target.closest && e.target.closest(hoverSel)) ring.classList.remove("is-hover");
            },
            true
        );
    })();

    /* ========================================================
       09 · CART + DRAWER
       ======================================================== */
    var closeDrawer;
    (function () {
        function setCartCount(n) {
            document.querySelectorAll(".cart-count").forEach(function (el) {
                el.textContent = n;
                el.setAttribute("data-count", n);
            });
        }
        /* merge rather than replace — 01c already put the daypart helpers here */
        window.SFV = window.SFV || {};
        window.SFV.setCartCount = setCartCount;
        setCartCount(0);

        var burger = document.querySelector(".nav-burger");
        var drawer = document.getElementById("drawer");
        var scrim = document.getElementById("drawer-scrim");
        var closeBtn = document.getElementById("drawer-close");

        function open() {
            drawer.classList.add("open");
            scrim.classList.add("open");
            burger.classList.add("open");
            burger.setAttribute("aria-expanded", "true");
            document.body.classList.add("is-locked");
        }
        closeDrawer = function () {
            if (!drawer) return;
            drawer.classList.remove("open");
            scrim.classList.remove("open");
            if (burger) {
                burger.classList.remove("open");
                burger.setAttribute("aria-expanded", "false");
            }
            document.body.classList.remove("is-locked");
        };

        if (burger)
            burger.addEventListener("click", function () {
                drawer.classList.contains("open") ? closeDrawer() : open();
            });
        if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
        if (scrim) scrim.addEventListener("click", closeDrawer);
        document.querySelectorAll(".drawer-link").forEach(function (a) {
            a.addEventListener("click", closeDrawer);
        });
    })();

    /* ========================================================
       10 · WINE CLUB TIERS + MODALS
       ======================================================== */
    (function () {
        var tiers = document.querySelectorAll(".tier");
        var selectedTier = "Seven Summits";
        tiers.forEach(function (t) {
            t.addEventListener("click", function () {
                tiers.forEach(function (x) {
                    x.classList.remove("active");
                });
                t.classList.add("active");
                selectedTier = t.getAttribute("data-tier");
            });
        });
        if (tiers[0]) tiers[0].classList.add("active");

        var scrim = document.getElementById("modal-scrim");
        var body = document.getElementById("modal-body");
        if (!scrim || !body) return;
        var lastFocus = null;

        function openModal(html) {
            lastFocus = document.activeElement;
            body.innerHTML = html;
            scrim.classList.add("open");
            document.body.classList.add("is-locked");
            dressButtons(body);
            var f = body.querySelector("input, select");
            if (f)
                setTimeout(function () {
                    f.focus();
                }, 460);
            wireForm();
        }
        function closeModal() {
            scrim.classList.remove("open");
            document.body.classList.remove("is-locked");
            if (lastFocus && lastFocus.focus) lastFocus.focus();
        }

        scrim.addEventListener("click", function (e) {
            if (e.target === scrim) closeModal();
        });
        document.addEventListener("click", function (e) {
            if (e.target.closest && e.target.closest(".modal .close")) closeModal();
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                if (closeDrawer) closeDrawer();
                closeModal();
            }
        });

        function clubModal() {
            return (
                '<button class="close" aria-label="Close">&times;</button>' +
                '<span class="eyebrow">The Strange Family Club</span>' +
                "<h3>Become part of the family</h3>" +
                '<p>You\'re joining the <span class="selected-tier">' +
                selectedTier +
                "</span> membership. Tell us where to send your first allocation — we'll reach out to confirm your release schedule.</p>" +
                '<form id="club-form">' +
                '<div class="field"><label>Membership</label><select name="tier">' +
                "<option" +
                (selectedTier === "Seven Summits" ? " selected" : "") +
                ">Seven Summits — Sparkling Wine Club</option>" +
                "<option" +
                (selectedTier === "Soaring Eagle" ? " selected" : "") +
                ">Soaring Eagle — Still Wine Club</option>" +
                "<option" +
                (selectedTier === "Take Flight" ? " selected" : "") +
                ">Take Flight — Mixed Club</option>" +
                "</select></div>" +
                '<div class="field"><label>Full name</label><input name="name" placeholder="Your name" required></div>' +
                '<div class="field"><label>Email</label><input name="email" type="email" placeholder="you@email.com" required></div>' +
                '<button type="submit" class="btn-solid">Request Membership <span class="arr">&rarr;</span></button>' +
                "</form>"
            );
        }

        function visitModal() {
            return (
                '<button class="close" aria-label="Close">&times;</button>' +
                '<span class="eyebrow">Los Olivos Tasting Room</span>' +
                "<h3>Plan your visit</h3>" +
                "<p>Reserve a seated tasting at our Los Olivos room. Open daily, 11am–5pm. Walk-ins welcome; reservations recommended for parties of four or more.</p>" +
                '<form id="visit-form">' +
                '<div class="field"><label>Party size</label><select name="party"><option>2 guests</option><option>3 guests</option><option>4 guests</option><option>5 guests</option><option>6+ guests</option></select></div>' +
                '<div class="field"><label>Preferred date</label><input name="date" type="date"></div>' +
                '<div class="field"><label>Email</label><input name="email" type="email" placeholder="you@email.com" required></div>' +
                '<button type="submit" class="btn-solid">Request Reservation <span class="arr">&rarr;</span></button>' +
                "</form>"
            );
        }

        function successHTML(title, msg) {
            return (
                '<button class="close" aria-label="Close">&times;</button>' +
                '<div class="modal-success">' +
                '<div class="check">&#10003;</div>' +
                '<span class="eyebrow">Received</span>' +
                "<h3>" +
                title +
                "</h3><p>" +
                msg +
                "</p></div>"
            );
        }

        function wireForm() {
            var cf = body.querySelector("#club-form");
            if (cf)
                cf.addEventListener("submit", function (e) {
                    e.preventDefault();
                    body.innerHTML = successHTML(
                        "Welcome to the flock",
                        "Thank you for joining the Strange Family Club. A member of our team will be in touch shortly to confirm your first release."
                    );
                    dressButtons(body);
                });
            var vf = body.querySelector("#visit-form");
            if (vf)
                vf.addEventListener("submit", function (e) {
                    e.preventDefault();
                    body.innerHTML = successHTML(
                        "Your table is requested",
                        "We've received your reservation request for Los Olivos. Watch your inbox for a confirmation from our tasting room team."
                    );
                    dressButtons(body);
                });
        }

        document.querySelectorAll('[data-open="club"]').forEach(function (b) {
            b.addEventListener("click", function (e) {
                e.preventDefault();
                if (closeDrawer) closeDrawer();
                openModal(clubModal());
            });
        });
        document.querySelectorAll('[data-open="visit"]').forEach(function (b) {
            b.addEventListener("click", function (e) {
                e.preventDefault();
                if (closeDrawer) closeDrawer();
                openModal(visitModal());
            });
        });

        /* newsletter */
        var news = document.getElementById("news-field");
        if (news)
            news.addEventListener("submit", function (e) {
                e.preventDefault();
                news.innerHTML = '<span style="font-size:13px;letter-spacing:.06em;color:var(--gold-soft)">Thank you — you\'re on the list.</span>';
            });
    })();
})();
