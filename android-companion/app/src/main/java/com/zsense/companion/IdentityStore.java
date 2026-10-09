package com.zsense.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONObject;
import org.json.JSONArray;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Ed25519 seed is encrypted at rest with a non-exportable Android Keystore AES key. */
final class IdentityStore {
    private static final String ALIAS = "zsense-companion-v1";
    private static final byte[] ED25519_SPKI_PREFIX = new byte[]{0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
    private static final String PREFS = "device-identity-v1";
    private final SharedPreferences prefs;
    private final Ed25519PrivateKeyParameters privateKey;
    private final byte[] publicDer;

    IdentityStore(Context context) throws Exception {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String secret = prefs.getString("private", "");
        byte[] seed;
        if (secret.isEmpty()) {
            seed = new byte[32];
            new SecureRandom().nextBytes(seed);
            if (!prefs.edit().putString("private", encrypt(seed)).commit())
                throw new IllegalStateException("无法保存设备身份。");
        } else {
            seed = decrypt(secret);
            if (seed.length != 32) throw new IllegalStateException("设备身份数据长度无效。");
        }
        privateKey = new Ed25519PrivateKeyParameters(seed, 0);
        Ed25519PublicKeyParameters publicKey = privateKey.generatePublicKey();
        publicDer = Arrays.copyOf(ED25519_SPKI_PREFIX, ED25519_SPKI_PREFIX.length + 32);
        System.arraycopy(publicKey.getEncoded(), 0, publicDer, ED25519_SPKI_PREFIX.length, 32);
        Ed25519Signer verifier = new Ed25519Signer();
        verifier.init(false, publicKey);
        byte[] probe = "zsense-companion-identity-check".getBytes(StandardCharsets.UTF_8);
        verifier.update(probe, 0, probe.length);
        if (!verifier.verifySignature(Base64.decode(sign(new String(probe, StandardCharsets.UTF_8)),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING))) {
            throw new IllegalStateException("设备私钥与公钥不匹配。");
        }
        Arrays.fill(seed, (byte) 0);
    }

    String publicPem() {
        String encoded = Base64.encodeToString(publicDer, Base64.NO_WRAP);
        StringBuilder pem = new StringBuilder("-----BEGIN PUBLIC KEY-----\n");
        for (int offset = 0; offset < encoded.length(); offset += 64)
            pem.append(encoded, offset, Math.min(offset + 64, encoded.length())).append('\n');
        return pem.append("-----END PUBLIC KEY-----\n").toString();
    }

    byte[] publicDer() { return publicDer.clone(); }

    String sign(String message) throws Exception {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, privateKey);
        byte[] content = message.getBytes(StandardCharsets.UTF_8);
        signer.update(content, 0, content.length);
        return Base64.encodeToString(signer.generateSignature(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    String deviceId() { return prefs.getString("device-id", ""); }
    void setDeviceId(String id) { prefs.edit().putString("device-id", id).apply(); }
    String email() { return prefs.getString("email", ""); }
    void setEmail(String email) { prefs.edit().putString("email", email).apply(); }

    void saveCloudPeer(String deviceId, String name) throws Exception {
        if (!deviceId.matches("[a-z0-9][a-z0-9-]{1,58}")) throw new IllegalArgumentException("云端设备号无效。");
        String label = name == null || name.isBlank() ? deviceId : name.trim();
        JSONObject peer = new JSONObject().put("deviceId", deviceId)
                .put("name", label.substring(0, Math.min(label.length(), 60)))
                .put("lastConnectedAt", System.currentTimeMillis());
        if (!prefs.edit().putString("cloud:" + deviceId, encrypt(peer.toString().getBytes(StandardCharsets.UTF_8))).commit())
            throw new IllegalStateException("无法保存云端设备。");
    }

    JSONArray cloudPeers() throws Exception {
        JSONArray result = new JSONArray();
        for (String key : prefs.getAll().keySet()) {
            if (!key.startsWith("cloud:")) continue;
            String stored = prefs.getString(key, "");
            if (stored.isEmpty()) continue;
            try {
                JSONObject peer = new JSONObject(new String(decrypt(stored), StandardCharsets.UTF_8));
                if (key.substring(6).equals(peer.optString("deviceId"))) result.put(peer);
            } catch (Exception ignored) { /* One corrupt shortcut must not hide the other devices. */ }
        }
        return result;
    }

    void forgetCloudPeer(String deviceId) {
        if (deviceId != null && deviceId.matches("[a-z0-9][a-z0-9-]{1,58}"))
            prefs.edit().remove("cloud:" + deviceId).commit();
    }

    void saveLanPeer(String deviceId, JSONObject peer) throws Exception {
        if (!prefs.edit().putString("lan:" + deviceId, encrypt(peer.toString().getBytes(StandardCharsets.UTF_8))).commit())
            throw new IllegalStateException("无法保存局域网设备授权。");
    }

    JSONObject lanPeer(String deviceId) throws Exception {
        String stored = prefs.getString("lan:" + deviceId, "");
        return stored.isEmpty() ? null : new JSONObject(new String(decrypt(stored), StandardCharsets.UTF_8));
    }

    void forgetLanPeer(String deviceId) throws Exception {
        JSONObject target = lanPeer(deviceId);
        if (target == null) return;
        String remote = target.optString("remoteDeviceId");
        String local = target.optString("deviceId");
        SharedPreferences.Editor editor = prefs.edit().remove("lan:" + deviceId);
        if (!remote.isEmpty()) editor.remove("lan:" + remote);
        if (!local.isEmpty()) editor.remove("lan:" + local);
        if (!editor.commit()) throw new IllegalStateException("无法清除已失效的局域网设备授权。");
    }

    JSONArray lanPeers() throws Exception {
        JSONArray result = new JSONArray();
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (String key : prefs.getAll().keySet()) {
            if (!key.startsWith("lan:")) continue;
            JSONObject peer = lanPeer(key.substring(4));
            if (peer == null) continue;
            String id = peer.optString("remoteDeviceId", peer.optString("deviceId", key.substring(4)));
            if (!id.isEmpty() && seen.add(id)) result.put(peer);
        }
        return result;
    }

    private SecretKey masterKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    private String encrypt(byte[] plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, masterKey(), new SecureRandom());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plain);
        byte[] result = Arrays.copyOf(iv, iv.length + encrypted.length);
        System.arraycopy(encrypted, 0, result, iv.length, encrypted.length);
        return Base64.encodeToString(result, Base64.NO_WRAP);
    }

    private byte[] decrypt(String encoded) throws Exception {
        byte[] data = Base64.decode(encoded, Base64.DEFAULT);
        if (data.length < 29) throw new IllegalStateException("设备身份数据已损坏。");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, masterKey(), new GCMParameterSpec(128, data, 0, 12));
        return cipher.doFinal(data, 12, data.length - 12);
    }
}
