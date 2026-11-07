package com.vpn.acremote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * AC Remote for Android.
 * The PC running AC Remote does the work (Matter, MirAIe, presets, timers); this app finds it and shows its remote.
 * It remembers two addresses: the PC on home Wi-Fi, and the private Tailscale address for when you're out,
 * and uses whichever answers.
 */
public class MainActivity extends Activity {
    private static final int PORT = 8080;
    private static final String PREFS = "acremote";
    private static final String KEY_HOME = "home_url";
    private static final String KEY_AWAY = "away_url";

    private WebView web;
    private View root;
    private View panel;
    private TextView title, message;
    private ProgressBar spinner;
    private LinearLayout found;
    private Button retry, scan, connect;
    private EditText address;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newCachedThreadPool();
    private SharedPreferences prefs;
    private String current; // the address the remote is loaded from
    private final AtomicBoolean scanning = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = findViewById(R.id.root);
        setUpEdgeToEdge();

        web = findViewById(R.id.web);
        panel = findViewById(R.id.panel);
        title = findViewById(R.id.title);
        message = findViewById(R.id.message);
        spinner = findViewById(R.id.spinner);
        found = findViewById(R.id.found);
        retry = findViewById(R.id.btn_retry);
        scan = findViewById(R.id.btn_scan);
        connect = findViewById(R.id.btn_connect);
        address = findViewById(R.id.address);

        setUpWebView();
        retry.setOnClickListener(v -> connectToSaved());
        scan.setOnClickListener(v -> scanNetwork());
        connect.setOnClickListener(v -> connectTyped());
        address.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) { connectTyped(); return true; }
            return false;
        });

        if (savedInstanceState != null && savedInstanceState.getString("current") != null) {
            current = savedInstanceState.getString("current");
            web.restoreState(savedInstanceState);
            showWeb();
        } else if (saved().isEmpty()) {
            scanNetwork();
        } else {
            connectToSaved();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (current != null && web.getVisibility() == View.VISIBLE) {
            out.putString("current", current);
            web.saveState(out);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        work.shutdownNow();
        super.onDestroy();
    }

    // ---------- web view ----------
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " ACRemoteApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "ACRemoteApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (current != null && u.toString().startsWith(current)) return false;
                // Other links (help pages, Tailscale) open in the phone's browser.
                try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) { }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    ui.post(() -> showProblem("Can't reach your PC",
                            "Check that the PC is on and AC Remote is running. Away from home, Tailscale needs to be on in this phone."));
                }
            }
        });
    }

    private void load(String base) {
        current = base;
        web.loadUrl(base + "/");
        showWeb();
    }

    private void showWeb() {
        panel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    /** Called from the web page (Settings, Change PC) and from the page's status (remembers the Tailscale address). */
    private class Bridge {
        @JavascriptInterface
        public void changePc() {
            ui.post(() -> {
                web.setVisibility(View.GONE);
                showSetup("Choose your PC", "Find it on this Wi-Fi or type its address.");
            });
        }

        @JavascriptInterface
        public void rememberRemote(String url) {
            String clean = normalise(url);
            if (clean != null && clean.startsWith("https://")) prefs.edit().putString(KEY_AWAY, clean).apply();
        }

        @JavascriptInterface
        public String version() { return BuildConfig.VERSION_NAME; }

        /** The page reports its top and bottom colours so the status and navigation bars blend in. */
        @JavascriptInterface
        public void setBars(String top, String bottom, boolean dark) {
            int t = parseColor(top), b = parseColor(bottom);
            if (t == 0 || b == 0) return;
            ui.post(() -> {
                root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{t, b}));
                setBarIcons(dark);
            });
        }
    }

    // ---------- system bars ----------
    /** Draw behind the status and navigation bars, and pad the content so nothing sits under them. */
    @SuppressWarnings("deprecation")
    private void setUpEdgeToEdge() {
        Window w = getWindow();
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) { w.setStatusBarContrastEnforced(false); w.setNavigationBarContrastEnforced(false); }
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setBarIcons(isNight());
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** Dark icons on the light blue page, light icons in dark mode. */
    @SuppressWarnings("deprecation")
    private void setBarIcons(boolean dark) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c == null) return;
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            c.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            d.setSystemUiVisibility(dark ? (f & ~light) : (f | light));
        }
    }

    /** Accepts "#RRGGBB" or "rgb(r, g, b)"; returns 0 when it can't read the colour. */
    static int parseColor(String s) {
        if (s == null) return 0;
        s = s.trim();
        try {
            if (s.startsWith("#")) return Color.parseColor(s);
            if (s.startsWith("rgb")) {
                String[] p = s.substring(s.indexOf('(') + 1, s.indexOf(')')).split("[,\\s/]+");
                return Color.rgb(Integer.parseInt(p[0].trim()), Integer.parseInt(p[1].trim()), Integer.parseInt(p[2].trim()));
            }
        } catch (Exception ignored) { }
        return 0;
    }

    // ---------- screens ----------
    private void resetBars() {
        root.setBackgroundResource(R.drawable.sky_gradient);
        setBarIcons(isNight());
    }

    private void showBusy(String t, String m) {
        resetBars();
        web.setVisibility(View.GONE);
        panel.setVisibility(View.VISIBLE);
        title.setText(t);
        message.setText(m);
        spinner.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);
        found.removeAllViews();
    }

    private void showProblem(String t, String m) {
        resetBars();
        web.setVisibility(View.GONE);
        panel.setVisibility(View.VISIBLE);
        title.setText(t);
        message.setText(m);
        spinner.setVisibility(View.GONE);
        retry.setVisibility(saved().isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void showSetup(String t, String m) {
        showProblem(t, m);
        String home = prefs.getString(KEY_HOME, null);
        if (home != null && address.getText().length() == 0) address.setText(home.replace("http://", ""));
    }

    // ---------- connecting ----------
    private List<String> saved() {
        List<String> list = new ArrayList<>();
        String home = prefs.getString(KEY_HOME, null);
        String away = prefs.getString(KEY_AWAY, null);
        if (home != null) list.add(home);
        if (away != null && !away.equals(home)) list.add(away);
        return list;
    }

    /** Try the saved addresses (home Wi-Fi first, then Tailscale) and open the first one that answers. */
    private void connectToSaved() {
        List<String> candidates = saved();
        if (candidates.isEmpty()) { scanNetwork(); return; }
        showBusy("Connecting", "Looking for your PC…");
        work.execute(() -> {
            List<Future<Boolean>> checks = new ArrayList<>();
            for (String c : candidates) checks.add(work.submit(() -> isAcRemote(c, 2500)));
            String winner = null;
            for (int i = 0; i < candidates.size() && winner == null; i++) {
                try { if (checks.get(i).get(4, TimeUnit.SECONDS)) winner = candidates.get(i); } catch (Exception ignored) { }
            }
            final String w = winner;
            ui.post(() -> {
                if (w != null) load(w);
                else showProblem("Can't reach your PC",
                        "Check that the PC is on and AC Remote is running, and that this phone is on your home Wi-Fi."
                                + (prefs.getString(KEY_AWAY, null) == null ? " To use it away from home, set up remote access on the PC." : " Away from home, turn on Tailscale in this phone."));
            });
        });
    }

    private void connectTyped() {
        hideKeyboard();
        String url = normalise(address.getText().toString());
        if (url == null) { showSetup("Check the address", "Type it like 192.168.1.20 or https://your-pc.ts.net"); return; }
        showBusy("Connecting", url);
        work.execute(() -> {
            boolean ok = isAcRemote(url, 4000);
            ui.post(() -> {
                if (ok) { remember(url); load(url); }
                else showSetup("No answer from that address", "Make sure AC Remote is running on the PC and the address is right. Away from home, Tailscale must be on in this phone.");
            });
        });
    }

    private void remember(String url) {
        SharedPreferences.Editor e = prefs.edit();
        if (url.startsWith("https://") || !isPrivateHost(Uri.parse(url).getHost())) e.putString(KEY_AWAY, url);
        else e.putString(KEY_HOME, url);
        e.apply();
    }

    /** Scan this Wi-Fi network for PCs running AC Remote. */
    private void scanNetwork() {
        if (!scanning.compareAndSet(false, true)) return;
        showBusy("Finding your PC", "Looking for AC Remote on this Wi-Fi. Keep the phone on your home Wi-Fi.");
        work.execute(() -> {
            List<String> hits = Collections.synchronizedList(new ArrayList<>());
            try {
                List<String> hosts = subnetHosts();
                ExecutorService pool = Executors.newFixedThreadPool(48);
                for (String h : hosts) {
                    pool.execute(() -> {
                        String url = "http://" + h + ":" + PORT;
                        if (isAcRemote(url, 700)) hits.add(url);
                    });
                }
                pool.shutdown();
                pool.awaitTermination(25, TimeUnit.SECONDS);
            } catch (Exception ignored) {
            } finally {
                scanning.set(false);
            }
            ui.post(() -> showScanResults(hits));
        });
    }

    private void showScanResults(List<String> hits) {
        if (hits.size() == 1) {
            remember(hits.get(0));
            load(hits.get(0));
            return;
        }
        if (hits.isEmpty()) {
            showSetup("Couldn't find your PC", "Make sure AC Remote is running on the PC and this phone is on the same Wi-Fi, then tap Find again. You can also type the PC's address.");
            return;
        }
        showSetup("Choose your PC", "AC Remote is running on more than one PC here.");
        found.removeAllViews();
        for (String h : hits) {
            Button b = new Button(this);
            b.setText(h.replace("http://", ""));
            b.setAllCaps(false);
            b.setTextColor(getColor(R.color.ink));
            b.setBackgroundResource(R.drawable.card);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
            lp.topMargin = dp(8);
            b.setLayoutParams(lp);
            b.setOnClickListener(v -> { remember(h); load(h); });
            found.addView(b);
        }
    }

    /** All addresses in this phone's Wi-Fi subnet (at most a /24), the likeliest first. */
    private List<String> subnetHosts() {
        List<String> out = new ArrayList<>();
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        Network n = cm.getActiveNetwork();
        LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
        if (lp == null) return out;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress a = la.getAddress();
            if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
            byte[] b = a.getAddress();
            String prefix = (b[0] & 255) + "." + (b[1] & 255) + "." + (b[2] & 255) + ".";
            int self = b[3] & 255;
            for (int i = 1; i < 255; i++) if (i != self) out.add(prefix + i);
            break;
        }
        return out;
    }

    // ---------- helpers ----------
    /** True if url answers like an AC Remote PC. */
    private static boolean isAcRemote(String base, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/status").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs + 500);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != 200) return false;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[2048];
                int r, total = 0;
                while ((r = in.read(chunk)) > 0 && total < 16384) { buf.write(chunk, 0, r); total += r; }
                return buf.toString("UTF-8").contains("\"app\":\"ac-remote\"");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Turns "192.168.1.20", "192.168.1.20:8080" or "your-pc.ts.net" into a full base address. */
    static String normalise(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            String host = s.split("[:/]")[0];
            s = (host.endsWith(".ts.net") ? "https://" : "http://") + s;
        }
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        String base = u.getScheme() + "://" + u.getHost();
        if (u.getPort() > 0) base += ":" + u.getPort();
        else if ("http".equals(u.getScheme()) && isPrivateHost(u.getHost())) base += ":" + PORT;
        return base;
    }

    static boolean isPrivateHost(String h) {
        if (h == null) return false;
        return h.startsWith("192.168.") || h.startsWith("10.") || h.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*") || h.endsWith(".local");
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(address.getWindowToken(), 0);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.getVisibility() == View.VISIBLE) {
            // Back closes an open sheet first, then leaves the app.
            web.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return true}return false})()", r -> {
                if (!"true".equals(r)) finish();
            });
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && current != null && panel.getVisibility() == View.VISIBLE && !saved().isEmpty()) {
            connectToSaved();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
