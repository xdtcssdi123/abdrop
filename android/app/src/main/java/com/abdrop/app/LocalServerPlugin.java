package com.abdrop.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
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
    private static String getLocalIpAddress() {
        try {
            for (Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
                 en.hasMoreElements(); ) {
                NetworkInterface ni = en.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (Enumeration<InetAddress> addrs = ni.getInetAddresses(); addrs.hasMoreElements(); ) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (SocketException ignored) {
        }
        return "127.0.0.1";
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
