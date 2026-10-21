import React from "react";

interface FormContainerProps {
  title: string;
  children: React.ReactNode;
}

// The sheet of paper the sign-in, sign-up and password pages are written on, with soft patches of colour behind it and a stroke of
// ink under its title.
export default function FormContainer({ title, children }: FormContainerProps) {
  return (
    <div className="mx-auto mt-10 max-w-md px-4 md:mt-16">
      <div className="glow-layer" aria-hidden="true">
        <div className="glow glow-a left-[6%] top-[12%] h-[26rem] w-[26rem] max-w-[85vw]" />
        <div className="glow glow-b bottom-[6%] right-[4%] h-[24rem] w-[24rem] max-w-[80vw]" />
      </div>
      <div className="card rise md:p-8" style={{ "--rise": "16px" } as React.CSSProperties}>
        <h1 className="text-center text-3xl md:text-4xl">{title}</h1>
        <span className="ink-rule ink-rule-center mb-6 mt-3" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
