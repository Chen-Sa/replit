function App() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#f9fafb",
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "4rem", fontWeight: "bold", color: "#10b981" }}>OK</div>
        <p style={{ marginTop: "0.5rem", color: "#6b7280", fontSize: "0.875rem" }}>
          API Server is running
        </p>
      </div>
    </div>
  );
}

export default App;
