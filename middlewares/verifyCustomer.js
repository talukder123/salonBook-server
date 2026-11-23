const verifyCustomer = (req, res, next) => {
  if (req.user?.role !== "user") {
    return res.status(403).json({
      success: false,
      message: "Forbidden access. Customer only.",
    });
  }

  next();
};

export default verifyCustomer;