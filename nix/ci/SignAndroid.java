import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.zip.ZipFile;
import jdk.security.jarsigner.JarSigner;

/** Read signing credentials at runtime without putting them on process argv. */
class SignAndroid {
    public static void main(String[] args) throws Exception {
        if (args.length != 6) throw new IllegalArgumentException("Expected six public paths/version arguments");
        Path secrets = Path.of(args[1]);
        char[] password = Files.readString(secrets.resolve("ANDROID_KEYSTORE_PASSWORD")).toCharArray();
        String alias = Files.readString(secrets.resolve("ANDROID_KEY_ALIAS")).strip();
        try {
            KeyStore keys = KeyStore.getInstance(Path.of(args[0]).toFile(), password);
            var entry = keys.getEntry(alias, new KeyStore.PasswordProtection(password));
            if (!(entry instanceof KeyStore.PrivateKeyEntry privateKey)) {
                throw new IllegalArgumentException("Signing alias is not a private key entry");
            }
            Path output = Path.of(args[4]);
            String stem = "gitworkshop-android-v" + args[5];
            // Invoke in this JVM so alias and passwords are never OS argv.
            PrintStream diagnostics = System.err;
            try {
                // The CLI can include the granted alias in failure diagnostics.
                System.setErr(new PrintStream(OutputStream.nullOutputStream()));
                Class.forName("com.android.apksigner.ApkSignerTool").getMethod("main", String[].class).invoke(null, (Object) new String[] {
                    "sign", "--v4-signing-enabled", "false", "--ks", args[0], "--ks-key-alias", alias,
                    "--ks-pass", "pass:" + new String(password),
                    "--key-pass", "pass:" + new String(password),
                    "--out", output.resolve(stem + ".apk").toString(), args[2]
                });
            } finally {
                System.setErr(diagnostics);
            }
            JarSigner signer = new JarSigner.Builder(privateKey).build();
            try (ZipFile input = new ZipFile(args[3]);
                 OutputStream signed = Files.newOutputStream(output.resolve(stem + ".aab"))) {
                signer.sign(input, signed);
            }
        } finally {
            Arrays.fill(password, '\0');
        }
    }
}
