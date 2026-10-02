package com.abdrop.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 局域网 Web 服务:在 App 内起一个极简 HTTP 服务器。
 *
 * 数据读写全部委托给 JS 层(WebView 里的 IndexedDB / localStorage):
 * - 收到 HTTP 请求 → notifyListeners('request', ...) 交给 JS
 * - JS 处理完调 respond(requestId, ...) → 原生把响应写回 socket
 *
 * 只做同源管理场景,不追求完整 HTTP/1.1 语义:
 * 支持 GET/POST/PUT/DELETE + Content-Length body + 统一 CORS 头,
 * 供局域网浏览器打开管理页并调 /api/*。
 */
@CapacitorPlugin(name = "LocalServer")
public class LocalServerPlugin extends Plugin {

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running = false;
    private final ConcurrentHashMap<String, CompletableFuture<JSObject>> pending =
            new ConcurrentHashMap<>();
    private final AtomicLong idGen = new AtomicLong(1);
    private int boundPort = 0;
    private String url = "";

    private static final int REQUEST_TIMEOUT_SECONDS = 30;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            call.resolve(makeInfo());
            return;
        }
        int targetPort = call.getInt("port", 8080);
        try {
            serverSocket = new ServerSocket(targetPort);
            boundPort = serverSocket.getLocalPort();
            running = true;
            acceptThread = new Thread(this::acceptLoop, "abdrop-lan-http");
            acceptThread.setDaemon(true);
            acceptThread.start();
            url = "http://" + getLocalIpAddress() + ":" + boundPort;
            call.resolve(makeInfo());
        } catch (IOException e) {
            call.reject("端口 " + targetPort + " 无法监听: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
        serverSocket = null;
        boundPort = 0;
        url = "";
        call.resolve(makeInfo());
    }

    /** JS 处理完一个请求后回填响应。 */
    @PluginMethod
    public void respond(PluginCall call) {
        String requestId = call.getString("requestId");
        CompletableFuture<JSObject> fut = requestId == null ? null : pending.remove(requestId);
        if (fut != null) {
            JSObject resp = new JSObject();
            resp.put("status", call.getInt("status", 200));
            resp.put("contentType", call.getString("contentType", "application/json"));
            resp.put("body", call.getString("body", ""));
            fut.complete(resp);
        }
        call.resolve();
    }

    private JSObject makeInfo() {
        JSObject info = new JSObject();
        info.put("running", running);
        info.put("url", url);
        info.put("port", boundPort);
        return info;
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                Thread t = new Thread(() -> handleConnection(socket), "abdrop-lan-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                // 服务器被关闭或 accept 失败 → 退出循环
                break;
            }
        }
    }

    private void handleConnection(Socket socket) {
        try (Socket s = socket;
             InputStream in = s.getInputStream();
             OutputStream out = s.getOutputStream()) {
            HttpRequest req = HttpRequest.parse(in);
            if (req == null) return;

            String requestId = Long.toString(idGen.incrementAndGet());
            CompletableFuture<JSObject> fut = new CompletableFuture<>();
            pending.put(requestId, fut);

            JSObject data = new JSObject();
            data.put("requestId", requestId);
            data.put("method", req.method);
            data.put("path", req.path);
            data.put("body", req.body);
            notifyListeners("request", data);

            JSObject resp;
            try {
                resp = fut.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            } catch (Exception e) {
                resp = new JSObject();
                resp.put("status", 500);
                resp.put("contentType", "application/json");
                resp.put("body", "{\"error\":\"处理超时\"}");
            } finally {
                pending.remove(requestId);
            }

            int status = resp.getInteger("status");
            byte[] bodyBytes = resp.getString("body").getBytes(StandardCharsets.UTF_8);
            String headers =
                    "HTTP/1.1 " + status + " " + reason(status) + "\r\n" +
                            "Content-Type: " + resp.getString("contentType") + "; charset=utf-8\r\n" +
                            "Content-Length: " + bodyBytes.length + "\r\n" +
                            "Access-Control-Allow-Origin: *\r\n" +
                            "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n" +
                            "Access-Control-Allow-Headers: Content-Type\r\n" +
                            "Connection: close\r\n\r\n";
            out.write(headers.getBytes(StandardCharsets.ISO_8859_1));
            out.write(bodyBytes);
            out.flush();
        } catch (IOException ignored) {
            // 连接被浏览器提前关闭等,静默
        }
    }

    private static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 201:
                return "Created";
            case 204:
                return "No Content";
            case 400:
                return "Bad Request";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 500:
                return "Internal Server Error";
            default:
                return "";
        }
    }

    /** 取局域网 IPv4(优先非回环、非虚拟网卡)。拿不到时回退 127.0.0.1。 */
    /**
     * 取局域网 IPv4 —— 优先「真正对外收发数据」的接口。
     *
     * 为什么不能直接拿第一个非回环 IPv4:手机上同时存在 WiFi / 移动数据 /
     * 热点 / VPN 等多个接口,遍历顺序不确定,可能拿到移动数据的 10.x 地址,
     * 而用户期望的是 WiFi 的 192.168.x.x。
     *
     * 策略(按可靠性降序):
     *   1. 默认路由所在接口(读 /proc/net/route,数据实际从哪个口出去)
     *   2. 名称像 WiFi/以太网 的接口(wlan/eth/en)
     *   3. 排除虚拟网卡后兜底取第一个 IPv4
     */
    private static String getLocalIpAddress() {
        String viaRoute = ipv4OfDefaultRouteInterface();
        if (viaRoute != null) return viaRoute;

        try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
                 en.hasMoreElements(); ) {
                NetworkInterface ni = en.nextElement();
                if (!isCandidate(ni)) continue;
                String name = ni.getName().toLowerCase(Locale.US);
                if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("en")) {
                    String ip = firstIpv4(ni);
                    if (ip != null) return ip;
                }
            }
            // 兜底:任意候选接口的第一个 IPv4
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
                 en.hasMoreElements(); ) {
                NetworkInterface ni = en.nextElement();
                if (!isCandidate(ni)) continue;
                String ip = firstIpv4(ni);
                if (ip != null) return ip;
            }
        } catch (SocketException ignored) {
        }
        return "127.0.0.1";
    }

    /** 是否候选:已启用、非回环、非虚拟网卡。 */
    private static boolean isCandidate(NetworkInterface ni) throws SocketException {
        if (!ni.isUp() || ni.isLoopback()) return false;
        String name = ni.getName().toLowerCase(Locale.US);
        // 排除常见虚拟/数据网卡:docker、VPN(tun)、移动数据(rmnet/radio)、热点(ap)、ppp
        return !(name.startsWith("docker") || name.startsWith("veth") || name.startsWith("virbr")
                || name.startsWith("tun") || name.startsWith("rmnet") || name.startsWith("radio")
                || name.startsWith("ap") || name.startsWith("ppp") || name.contains("dummy"));
    }

    /** 取接口上第一个 IPv4。 */
    private static String firstIpv4(NetworkInterface ni) {
        for (Enumeration<InetAddress> addrs = ni.getInetAddresses(); addrs.hasMoreElements(); ) {
            InetAddress addr = addrs.nextElement();
            if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                return addr.getHostAddress();
            }
        }
        return null;
    }

    /** 读 /proc/net/route,找默认路由(目的 0.0.0.0)对应的接口 IP。 */
    private static String ipv4OfDefaultRouteInterface() {
        BufferedReader br = null;
        try {
            br = new BufferedReader(new FileReader("/proc/net/route"));
            String line;
            // 首行是表头
            while ((line = br.readLine()) != null) {
                String[] parts = line.trim().split("\\s+");
                if (parts.length < 3) continue;
                // parts[0]=接口名 parts[1]=目的地址(十六进制小端) —— 全 0 即默认路由
                if (parts[1].equals("00000000") && !parts[0].equals("lo")) {
                    String iface = parts[0];
                    try {
                        NetworkInterface ni = NetworkInterface.getByName(iface);
                        if (ni != null && isCandidate(ni)) {
                            String ip = firstIpv4(ni);
                            if (ip != null) return ip;
                        }
                    } catch (SocketException ignored) {
                    }
                }
            }
        } catch (IOException ignored) {
        } finally {
            if (br != null) {
                try {
                    br.close();
                } catch (IOException ignored) {
                }
            }
        }
        return null;
    }

    /** 极简 HTTP 请求解析:请求行 + 头(取 Content-Length)+ body。 */
    static class HttpRequest {
        String method;
        String path;
        String body;

        static HttpRequest parse(InputStream in) throws IOException {
            String requestLine = readAsciiLine(in);
            if (requestLine == null || requestLine.isEmpty()) return null;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return null;

            HttpRequest req = new HttpRequest();
            req.method = parts[0];
            req.path = parts[1];

            int contentLength = 0;
            String line;
            while ((line = readAsciiLine(in)) != null && !line.isEmpty()) {
                if (line.toLowerCase(Locale.US).startsWith("content-length:")) {
                    try {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }

            if (contentLength > 0) {
                byte[] buf = new byte[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int n = in.read(buf, read, contentLength - read);
                    if (n < 0) break;
                    read += n;
                }
                req.body = new String(buf, 0, read, StandardCharsets.UTF_8);
            } else {
                req.body = "";
            }
            return req;
        }

        /** 逐字节读一行(不缓冲,避免把 body 读走)。 */
        private static String readAsciiLine(InputStream in) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            int b;
            while ((b = in.read()) != -1) {
                if (b == '\n') break;
                if (b != '\r') buf.write(b);
            }
            if (buf.size() == 0) return null;
            return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
        }
    }
}
