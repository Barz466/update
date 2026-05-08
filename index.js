function getHash(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}
