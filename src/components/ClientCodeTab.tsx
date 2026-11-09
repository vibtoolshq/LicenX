import { Check, Copy, Cpu, Download, FileCode, FolderArchive, ShieldCheck, Terminal } from 'lucide-react';
import React, { useState } from 'react';
import { api } from '../services/apiClient';

interface ClientCodeTabProps {
  publicKeyPem: string;
}

export const ClientCodeTab: React.FC<ClientCodeTabProps> = ({ publicKeyPem }) => {
  const [activeLang, setActiveLang] = useState<'python' | 'curl' | 'node' | 'csharp'>(() => {
    try {
      const saved = sessionStorage.getItem('vcon_client_code_lang');
      if (saved === 'python' || saved === 'curl' || saved === 'node' || saved === 'csharp') {
        return saved;
      }
    } catch {}
    return 'python';
  });

  const handleSelectLang = (lang: 'python' | 'curl' | 'node' | 'csharp') => {
    setActiveLang(lang);
    try {
      sessionStorage.setItem('vcon_client_code_lang', lang);
    } catch {}
  };

  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const serverUrl = window.location.origin;

  const handleDownloadSdk = async () => {
    try {
      setDownloading(true);
      await api.downloadPythonSdk();
    } catch (err: any) {
      alert(err.message || 'Failed to download SDK package');
    } finally {
      setDownloading(false);
    }
  };

  const pythonQuickExample = `#!/usr/bin/env python3
"""
Primary LicenX Python SDK
Install from a verified wheel or extracted licenx-python-sdk.zip:
    python -m pip install .
Create app-root licenx.config.py with literal app_config, app_version,
trusted HTTPS server URL and the administrator-provisioned public key.
"""

from licenx import XLicenseClient

client = XLicenseClient()  # Reads app-root licenx.config.py, no JSON required
key = input("License key: ").strip()
result = client.login(key)
if not result.success:
    raise SystemExit("License denied: " + str(result.code))
print("Signed license validated. Tier: " + str(client.get_tier()))
# Keep the client alive during licensed work; explicit logout releases a device.
# client.logout()
`;

  const curlCode = `# 1. Validate & Auto-bind Hardware Device with Multi-App Scoping
curl -X POST "${serverUrl}/api/v1/license/validate" \\
  -H "Content-Type: application/json" \\
  -d '{
    "license_key": "VCON-ABCD-EFGH-IJKL",
    "app_name": "vcon_default",
    "app_version": "REPLACE_WITH_CLIENT_RELEASE_VERSION",
    "hwid": "HWID-9F82-BCA1-48C7-1122",
    "device_name": "DESKTOP-CLIENT",
    "os_info": "Windows 11 Pro 64-bit"
  }'

# 2. Get Server Ed25519 Public Key
curl "${serverUrl}/api/v1/public-key"

# 3. Heartbeat Ping (Periodic verification)
curl -X POST "${serverUrl}/api/v1/license/ping" \\
  -H "Content-Type: application/json" \\
  -d '{
    "license_key": "VCON-ABCD-EFGH-IJKL",
    "hwid": "HWID-9F82-BCA1-48C7-1122",
    "app_name": "vcon_default"
  }'

# 4. Instant Logout / Unbind Device (Releases hardware slot)
curl -X POST "${serverUrl}/api/v1/license/logout" \\
  -H "Content-Type: application/json" \\
  -d '{
    "license_key": "VCON-ABCD-EFGH-IJKL",
    "hwid": "HWID-9F82-BCA1-48C7-1122",
    "app_name": "vcon_default"
  }'
`;

  const nodeCode = `import crypto from 'crypto';

const SERVER_URL = '${serverUrl}';
const PUBLIC_KEY_PEM = \`${publicKeyPem || '-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----'}\`;

export async function validateLicense(licenseKey: string, hwid: string, appVersion: string, appName = 'vcon_default'): Promise<boolean> {
  const res = await fetch(\`\${SERVER_URL}/api/v1/license/validate\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      license_key: licenseKey,
      hwid: hwid,
      app_name: appName,
      app_version: appVersion,
      device_name: 'NodeClient',
      os_info: process.platform,
      client_time: Date.now(),
    }),
  });

  if (!res.ok) return false;
  const json = await res.json();
  const signature = json.signature;
  delete json.signature;
  delete json.public_key;

  // Canonicalize & Verify Signature (RSA 2048-bit SHA-256)
  const sortedKeys = Object.keys(json).sort();
  const sortedObj: any = {};
  for (const k of sortedKeys) sortedObj[k] = json[k];
  const canonicalStr = JSON.stringify(sortedObj);

  const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  if (publicKey.asymmetricKeyType === 'ed25519') {
    return crypto.verify(null, Buffer.from(canonicalStr), publicKey, Buffer.from(signature, 'base64'));
  }
  const verify = crypto.createVerify('SHA256');
  verify.update(canonicalStr);
  return verify.verify(publicKey, Buffer.from(signature, 'base64'));
}
`;

  const csharpCode = `using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

public class VconLicenseClient
{
    private static readonly string ServerUrl = "${serverUrl}";

    public static async Task<bool> ValidateAsync(string licenseKey, string hwid, string appVersion, string appName = "vcon_default")
    {
        using var client = new HttpClient();
        var payload = new
        {
            license_key = licenseKey,
            hwid = hwid,
            app_name = appName,
            app_version = appVersion,
            device_name = Environment.MachineName,
            os_info = Environment.OSVersion.ToString(),
            client_time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        var response = await client.PostAsync($"{ServerUrl}/api/v1/license/validate", content);

        return response.IsSuccessStatusCode;
    }
}
`;

  const getCurrentCode = () => {
    switch (activeLang) {
      case 'python':
        return pythonQuickExample;
      case 'curl':
        return curlCode;
      case 'node':
        return nodeCode;
      case 'csharp':
        return csharpCode;
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getCurrentCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3 font-mono text-xs max-w-5xl">
      {/* Python SDK Package Banner */}
      <div className="p-3.5 rounded bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded bg-indigo-950/50 border border-indigo-800/50 text-indigo-400">
            <FolderArchive className="w-5 h-5" />
          </div>
          <div>
            <div className="font-semibold text-slate-200 text-xs">
              Python Client Protection SDK (`licenx`)
            </div>
            <div className="text-[11px] text-slate-400">
              Modular Python package with HWID lock, Ed25519 signing, 20min daemon thread & auto slot release.
            </div>
          </div>
        </div>

        <button
          onClick={handleDownloadSdk}
          disabled={downloading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-indigo-600/90 hover:bg-indigo-600 text-slate-100 font-medium transition-colors text-xs shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          {downloading ? 'Preparing ZIP...' : 'Download Python SDK (.ZIP)'}
        </button>
      </div>

      {/* SDK Architecture Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="p-2.5 rounded bg-slate-900/40 border border-slate-800 space-y-1">
          <div className="flex items-center gap-1.5 text-slate-200 font-medium text-[11px]">
            <FileCode className="w-3.5 h-3.5 text-indigo-400" />
            <span>config.py</span>
          </div>
          <p className="text-[10px] text-slate-400">Loads app-root literal licenx.config.py without executing Python code.</p>
        </div>

        <div className="p-2.5 rounded bg-slate-900/40 border border-slate-800 space-y-1">
          <div className="flex items-center gap-1.5 text-slate-200 font-medium text-[11px]">
            <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            <span>device.py</span>
          </div>
          <p className="text-[10px] text-slate-400">HDD/SSD + CPU + Motherboard UUID SHA-256 fingerprinting.</p>
        </div>

        <div className="p-2.5 rounded bg-slate-900/40 border border-slate-800 space-y-1">
          <div className="flex items-center gap-1.5 text-slate-200 font-medium text-[11px]">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
            <span>login.py</span>
          </div>
          <p className="text-[10px] text-slate-400">Strict online authentication & Ed25519 signature checks.</p>
        </div>

        <div className="p-2.5 rounded bg-slate-900/40 border border-slate-800 space-y-1">
          <div className="flex items-center gap-1.5 text-slate-200 font-medium text-[11px]">
            <Terminal className="w-3.5 h-3.5 text-indigo-400" />
            <span>storage.py & logout.py</span>
          </div>
          <p className="text-[10px] text-slate-400">20min background heartbeat daemon & instant slot releasing.</p>
        </div>
      </div>

      {/* Code Snippets Box */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-medium text-slate-300 uppercase tracking-wider text-xs">
            Integration Code & SDK Usage
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded p-0.5">
            <button
              onClick={() => handleSelectLang('python')}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                activeLang === 'python' ? 'bg-indigo-600/90 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Python (SDK)
            </button>
            <button
              onClick={() => handleSelectLang('curl')}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                activeLang === 'curl' ? 'bg-indigo-600/90 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              cURL / REST
            </button>
            <button
              onClick={() => handleSelectLang('node')}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                activeLang === 'node' ? 'bg-indigo-600/90 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Node.js
            </button>
            <button
              onClick={() => handleSelectLang('csharp')}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                activeLang === 'csharp' ? 'bg-indigo-600/90 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              C# / .NET
            </button>
          </div>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-850 text-slate-300 border border-slate-800 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="p-3 bg-slate-950 border border-slate-800 rounded overflow-x-auto">
        <pre className="text-slate-300 text-[11px] leading-relaxed font-mono select-all">
          {getCurrentCode()}
        </pre>
      </div>
    </div>
  );
};
