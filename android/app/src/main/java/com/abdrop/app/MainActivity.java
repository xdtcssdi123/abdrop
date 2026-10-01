package com.abdrop.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 局域网 Web 服务插件:registerPlugin 必须在 super.onCreate() 之前调用,
        // 因为 BridgeActivity.onCreate 内部会 load() 并装配插件
        registerPlugin(LocalServerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
