const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Forbidden access. Admin only.",
    });
  }

  next();
};

export default verifyAdmin;