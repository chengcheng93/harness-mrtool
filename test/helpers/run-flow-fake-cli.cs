using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Web.Script.Serialization;
public class FakeCli {
 public static int Main(string[] args) {
  var json = new JavaScriptSerializer(); json.MaxJsonLength = 16000000;
  string mode = Environment.GetEnvironmentVariable("RUN_FLOW_FAKE_MODE") ?? "ok";
  string command = args[0] + ((args[0] == "schema" || args[0] == "profiles") ? " " + args[1] : "");
  string trigger = Environment.GetEnvironmentVariable("RUN_FLOW_FAKE_COMMAND") ?? command;
  string log = Environment.GetEnvironmentVariable("RUN_FLOW_FAKE_LOG");
  File.AppendAllText(log, json.Serialize(new {kind="start", args=args, cwd=Environment.CurrentDirectory, pid=Process.GetCurrentProcess().Id}) + "\n");
  bool selected = command == trigger;
  byte[] bytes; using(var input = new MemoryStream()) { if(!(selected && mode == "early")) Console.OpenStandardInput().CopyTo(input); bytes=input.ToArray(); }
  string hash; using(var sha=SHA256.Create()) { hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
  File.AppendAllText(log, json.Serialize(new {kind="input", hash=hash, length=bytes.Length}) + "\n");
  if(selected && (mode == "long" || mode == "block")) Thread.Sleep(mode == "long" ? 31000 : 120000);
  Console.OutputEncoding = new UTF8Encoding(false);
  Console.Error.Write("glpat-fake-secret request-body candidate-token");
  if(selected && mode == "invalid") { Console.Write("glpat-fake-secret broken-json"); return 1; }
  if(selected && mode == "malformed") { Console.Write("{\"ok\":true}"); return 0; }
  if(selected && mode == "invalid-utf8") {
   // Bound the regression: an undrained OS pipe would otherwise hang this test.
   var watchdog = new Thread(() => { Thread.Sleep(6000); Process.GetCurrentProcess().Kill(); });
   watchdog.IsBackground = true; watchdog.Start();
   using(var output = Console.OpenStandardOutput()) {
    output.WriteByte(0xff);
    output.Write(new byte[3000000], 0, 3000000);
   }
   return 0;
  }
  string raw = Environment.GetEnvironmentVariable("RUN_FLOW_FAKE_OUTPUT");
  if(selected && raw != null) { Console.Write(raw); return 0; }
  bool ok = !(selected && (mode == "false" || mode == "nonzero" || mode == "early"));
  string padding = selected && mode == "large" ? new string('x', 2000000) : "";
  Thread stderr = new Thread(() => { if(padding.Length > 0) Console.Error.Write(padding); }); stderr.Start();
  var envelope = new {schemaVersion=1, ok=ok, code=ok ? "OK" : "INPUT_ERROR", message="fake", versions=new {cliVersion="0.1.11"}, update=new {activationRequired=true, hostRefreshMayBeRequired=true}, validation=new {valid=ok, issues=new object[0]}, remoteWrite=new {state="none", operations=new object[0]}, warnings=new object[0], error=ok ? null : new {field="request", expected="valid", actual="invalid", safeNextStep="stop"}, data=new {command=command, hash=hash, schema=new {all=true}, profiles=new[]{"code","docs"}, candidates=new[]{new {id="candidate"}}, binding=new {head="abc"}, padding=padding}};
  Console.Write(json.Serialize(envelope)); stderr.Join();
  return selected && (mode == "nonzero" || mode == "early") ? 7 : 0;
 }
}
