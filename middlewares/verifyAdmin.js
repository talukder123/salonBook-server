const verifyAdmin = (req, res, next) => {
  console.log("User role:", req.user?.role);

  if (req.user?.role !== "admin") {
    console.log("ADMIN CHECK FAILED:", req.user?.role);

    return res.status(403).json({
      success: false,
      message: "Forbidden access. Admin only.",
    });
  }

  next();
};

export default verifyAdmin;