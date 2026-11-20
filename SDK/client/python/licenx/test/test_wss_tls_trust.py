"""P01: strict WSS CA trust behavior, entirely offline using TLS MemoryBIO."""
import datetime
import os
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from licenx.realtime import _verified_wss_context


class WssTrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.dir = Path(cls.temp.name)
        now = datetime.datetime.utcnow()
        root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Isolated P01 Test Root")])
        root = (
            x509.CertificateBuilder()
            .subject_name(root_name)
            .issuer_name(root_name)
            .public_key(root_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=3))
            .not_valid_after(now + datetime.timedelta(days=5))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()),
                critical=False,
            )
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
                critical=False,
            )
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False, content_commitment=False,
                    key_encipherment=False, data_encipherment=False,
                    key_agreement=False, key_cert_sign=True, crl_sign=True,
                    encipher_only=False, decipher_only=False,
                ),
                critical=True,
            )
            .sign(root_key, hashes.SHA256())
        )
        cls.ca_path = cls.dir / "root.pem"
        cls.ca_path.write_bytes(root.public_bytes(serialization.Encoding.PEM))
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.key_path = cls.dir / "server.key"
        cls.key_path.write_bytes(server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
        cls.certs = {}
        for label, expires in (
            ("valid", now + datetime.timedelta(days=2)),
            ("expired", now - datetime.timedelta(days=1)),
        ):
            leaf = (
                x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
                .issuer_name(root_name)
                .public_key(server_key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(days=3))
                .not_valid_after(expires)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(
                    x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()),
                    critical=False,
                )
                .add_extension(
                    x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
                    critical=False,
                )
                .add_extension(
                    x509.KeyUsage(
                        digital_signature=True, content_commitment=False,
                        key_encipherment=True, data_encipherment=False,
                        key_agreement=False, key_cert_sign=False, crl_sign=False,
                        encipher_only=False, decipher_only=False,
                    ),
                    critical=True,
                )
                .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
                .add_extension(
                    x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
                )
                .sign(root_key, hashes.SHA256())
            )
            path = cls.dir / (label + ".pem")
            path.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
            cls.certs[label] = path

    @classmethod
    def _server_context(cls, label="valid"):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cls.certs[label]), str(cls.key_path))
        return ctx

    @staticmethod
    def _handshake(client_ctx, server_ctx, hostname):
        """Local memory-only TLS: neither networking nor a license server."""
        client_in, client_out = ssl.MemoryBIO(), ssl.MemoryBIO()
        server_in, server_out = ssl.MemoryBIO(), ssl.MemoryBIO()
        client = client_ctx.wrap_bio(
            client_in, client_out, server_side=False, server_hostname=hostname
        )
        server = server_ctx.wrap_bio(server_in, server_out, server_side=True)
        c_done = s_done = False
        for _ in range(30):
            if not c_done:
                try:
                    client.do_handshake()
                    c_done = True
                except ssl.SSLWantReadError:
                    pass
            outgoing = client_out.read()
            if outgoing:
                server_in.write(outgoing)
            if not s_done:
                try:
                    server.do_handshake()
                    s_done = True
                except ssl.SSLWantReadError:
                    pass
                except ssl.SSLError:
                    if c_done:
                        raise
                    # Client verification errors can make the peer reject later.
                    pass
            incoming = server_out.read()
            if incoming:
                client_in.write(incoming)
            if c_done and s_done:
                return client
        raise AssertionError("Isolated TLS handshake did not complete")

    def _context_with_test_root(self):
        with patch("certifi.where", return_value=str(self.ca_path)):
            return _verified_wss_context()

    def test_trust_source_adds_public_bundle_without_losing_system_roots(self):
        before = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
        context = self._context_with_test_root()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertTrue(set(before.get_ca_certs(binary_form=True)).issubset(
            set(context.get_ca_certs(binary_form=True))
        ))
        self.assertGreaterEqual(len(context.get_ca_certs()), len(before.get_ca_certs()) + 1)

    def test_valid_test_root_and_hostname_are_accepted(self):
        tls = self._handshake(self._context_with_test_root(), self._server_context(), "localhost")
        self.assertEqual(tls.version()[:3], "TLS")

    def test_unknown_issuer_is_rejected_with_verification_enabled(self):
        context = _verified_wss_context()  # Real certifi, without the synthetic root.
        with self.assertRaises(ssl.SSLCertVerificationError) as caught:
            self._handshake(context, self._server_context(), "localhost")
        self.assertEqual(caught.exception.verify_code, 20)

    def test_hostname_mismatch_is_rejected(self):
        with self.assertRaises(ssl.SSLCertVerificationError) as caught:
            self._handshake(self._context_with_test_root(), self._server_context(), "not-localhost.invalid")
        self.assertNotEqual(caught.exception.verify_code, 0)

    def test_expired_certificate_is_rejected(self):
        with self.assertRaises(ssl.SSLCertVerificationError) as caught:
            self._handshake(self._context_with_test_root(), self._server_context("expired"), "localhost")
        self.assertEqual(caught.exception.verify_code, 10)

    def test_missing_certifi_file_is_safe_failure(self):
        missing = str(self.dir / "missing-ca.pem")
        with patch("certifi.where", return_value=missing):
            with self.assertRaises(ssl.SSLError) as caught:
                _verified_wss_context()
        self.assertIn("REALTIME_CA_BUNDLE_UNAVAILABLE", str(caught.exception))
        self.assertNotIn(missing, str(caught.exception))

    def test_corrupt_certifi_file_is_safe_failure(self):
        bad = self.dir / "bad-ca.pem"
        bad.write_bytes(b"NOT A TRUSTED PEM BUNDLE\n")
        with patch("certifi.where", return_value=str(bad)):
            with self.assertRaises(ssl.SSLError) as caught:
                _verified_wss_context()
        self.assertNotIn(str(bad), str(caught.exception))

    def test_missing_optional_certifi_import_fails_closed(self):
        with patch.dict(sys.modules, {"certifi": None}):
            with self.assertRaisesRegex(ssl.SSLError, "REALTIME_CA_BUNDLE_UNAVAILABLE"):
                _verified_wss_context()


if __name__ == "__main__":
    unittest.main()
